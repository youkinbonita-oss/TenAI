export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb"
    }
  }
};

const FREE_MODELS = [
  "openrouter/free",
  "openai/gpt-oss-120b:free",
  "qwen/qwen3-coder:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-26b-a4b-it:free"
];

const VISION_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
];

// Used only when Think Harder is active. gpt-oss-120b:free supports
// genuine configurable reasoning depth on OpenRouter, so it's tried first
// with the reasoning parameter set. If it's unavailable, this falls back
// to the same models as normal chat (FREE_MODELS) — just with a stronger
// prompt and a larger token budget, which helps regardless of whether the
// specific fallback model has native reasoning support.
const THINK_MODELS = [
  "openai/gpt-oss-120b:free"
];

// Used only when Plugins is active. Must be a model that reliably supports
// OpenAI-style tool/function calling — nemotron-3-super is documented as
// tools-capable. Falls back to FREE_MODELS (without tools) if unavailable,
// so Plugins mode degrades to a normal answer rather than erroring out.
const PLUGIN_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free"
];

const NORMAL_SYSTEM_PROMPT =
  "You are TenAI, a helpful assistant. Always reply in natural conversational language, never in a labeled or classifier-style format such as 'User Safety: safe'. When an image is provided, immediately describe what is in the image in plain language, then answer any question the user asked about it.";

const THINK_HARDER_SYSTEM_PROMPT =
  "You are TenAI, a helpful assistant currently in a deeper reasoning mode for a difficult question. " +
  "Think through the problem carefully and step by step before answering. Consider multiple angles, " +
  "check your own reasoning for mistakes, and work through any necessary details thoroughly. " +
  "Once you've reasoned it through, give a clear, well-organized final answer. " +
  "Always reply in natural conversational language, never in a labeled or classifier-style format.";

const PLUGINS_TOOL_HINT =
  " You have access to a calculator tool for precise arithmetic and math. " +
  "Whenever the user asks for a calculation, use the calculator tool instead of computing it yourself " +
  "— your own mental math can be wrong, the tool is always exact.";

function lastMessageHasImage(messages) {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return Array.isArray(last.content) && last.content.some(function(part) {
    return part.type === "image_url";
  });
}

// ---------- Plugin tool system ----------
// Fixed, server-side-only whitelist. No dynamic/remote plugin loading, no
// arbitrary code execution, no side-effect actions — every tool here is a
// simple, read-only, deterministic function.

const TOOLS = [
  {
    type: "function",
    function: {
      name: "calculator",
      description:
        "Evaluates a mathematical expression and returns the precise numeric result. " +
        "Use this for any arithmetic or numeric calculation instead of computing it yourself.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "The math expression to evaluate, e.g. '12 * (3 + 4) / 2' or '2^10 - 5'"
          }
        },
        required: ["expression"]
      }
    }
  }
];

// Safe recursive-descent arithmetic evaluator. Deliberately does NOT use
// eval() or the Function() constructor — it only ever turns a
// pre-validated numeric/operator character string into a number by
// walking it token by token.
function safeCalculate(expression) {
  if (typeof expression !== "string") {
    throw new Error("Expression must be a string");
  }

  const cleaned = expression.trim();

  if (cleaned.length === 0) {
    throw new Error("Empty expression");
  }
  if (cleaned.length > 200) {
    throw new Error("Expression too long");
  }
  if (!/^[0-9+\-*/^().\s]+$/.test(cleaned)) {
    throw new Error("Expression contains unsupported characters");
  }

  let pos = 0;

  function peek() { return cleaned[pos]; }
  function advance() { return cleaned[pos++]; }
  function skipSpaces() { while (pos < cleaned.length && /\s/.test(peek())) pos++; }

  function parseExpression() {
    skipSpaces();
    let value = parseTerm();
    skipSpaces();
    while (peek() === '+' || peek() === '-') {
      const op = advance();
      skipSpaces();
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
      skipSpaces();
    }
    return value;
  }

  function parseTerm() {
    skipSpaces();
    let value = parseFactor();
    skipSpaces();
    while (peek() === '*' || peek() === '/') {
      const op = advance();
      skipSpaces();
      const rhs = parseFactor();
      if (op === '/') {
        if (rhs === 0) throw new Error("Division by zero");
        value = value / rhs;
      } else {
        value = value * rhs;
      }
      skipSpaces();
    }
    return value;
  }

  function parseFactor() {
    skipSpaces();
    let value = parseUnary();
    skipSpaces();
    while (peek() === '^') {
      advance();
      skipSpaces();
      const rhs = parseUnary();
      value = Math.pow(value, rhs);
      skipSpaces();
    }
    return value;
  }

  function parseUnary() {
    skipSpaces();
    if (peek() === '-') { advance(); return -parseUnary(); }
    if (peek() === '+') { advance(); return parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    skipSpaces();
    if (peek() === '(') {
      advance();
      const value = parseExpression();
      skipSpaces();
      if (peek() !== ')') throw new Error("Mismatched parentheses");
      advance();
      return value;
    }
    const start = pos;
    while (pos < cleaned.length && /[0-9.]/.test(peek())) pos++;
    if (pos === start) throw new Error("Expected a number at position " + pos);
    const numStr = cleaned.slice(start, pos);
    const num = parseFloat(numStr);
    if (isNaN(num)) throw new Error("Invalid number: " + numStr);
    return num;
  }

  const result = parseExpression();
  skipSpaces();

  if (pos !== cleaned.length) {
    throw new Error("Unexpected character at position " + pos);
  }
  if (!isFinite(result)) {
    throw new Error("Result is not a finite number");
  }

  return result;
}

function executeTool(name, argsJson) {
  let args;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch (err) {
    return JSON.stringify({ error: "Invalid tool arguments" });
  }

  if (name === "calculator") {
    try {
      const result = safeCalculate(args.expression);
      return JSON.stringify({ result: result });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  return JSON.stringify({ error: "Unknown tool: " + name });
}

// Writes a single complete answer as a synthetic SSE stream, matching the
// exact format real OpenRouter streaming responses use. This lets the
// Plugins path return an already-known final answer (e.g. when no tool
// was needed) without a second network round trip, while keeping the
// response contract identical to every other endpoint response the
// frontend already knows how to read.
function writeSyntheticStream(res, text) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });
  const chunk = { choices: [{ delta: { content: text } }] };
  res.write("data: " + JSON.stringify(chunk) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}

async function pipeStreamToResponse(res, upstreamResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value, { stream: true }));
  }

  res.end();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message, messages, image, thinkHarder, plugins } = req.body || {};

    let finalMessages = Array.isArray(messages) ? messages : [];

    finalMessages = finalMessages.filter(function(m) {
      if (!m) return false;
      if (typeof m.content === "string") return m.content.trim().length > 0;
      if (Array.isArray(m.content)) return m.content.length > 0;
      return false;
    }).map(function(m) {
      return {
        role: m.role === "ai" || m.role === "assistant" ? "assistant" : "user",
        content: m.content
      };
    });

    if (finalMessages.length === 0 && typeof message === "string" && message.trim().length > 0) {
      finalMessages = [{ role: "user", content: message }];
    }

    if (finalMessages.length === 0) {
      return res.status(400).json({ error: "No message content provided" });
    }

    const hasImage = lastMessageHasImage(finalMessages) || typeof image === "string";

    // Think Harder and Plugins only apply to text questions — image
    // analysis already uses a separate, purpose-built vision model list,
    // and is unaffected no matter what these flags say.
    const useThinkHarder = !!thinkHarder && !hasImage;
    const usePlugins = !!plugins && !hasImage;

    let systemPrompt = hasImage
      ? NORMAL_SYSTEM_PROMPT
      : (useThinkHarder ? THINK_HARDER_SYSTEM_PROMPT : NORMAL_SYSTEM_PROMPT);

    if (usePlugins) {
      systemPrompt += PLUGINS_TOOL_HINT;
    }

    finalMessages = [
      { role: "system", content: systemPrompt },
      ...finalMessages
    ];

    if (hasImage) {
      const modelList = VISION_MODELS;
      let data = null;
      let lastError = null;

      for (const model of modelList) {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: model,
            messages: finalMessages,
            max_tokens: 450
          })
        });

        const result = await response.json();

        if (!result.error && result.choices?.[0]?.message?.content) {
          data = result;
          console.log("Used vision model (non-streaming):", model);
          break;
        }

        lastError = result.error?.message || "Unknown error";
        console.log(`Vision model ${model} failed:`, lastError);
      }

      if (!data) {
        return res.status(500).json({ error: "All vision models unavailable: " + lastError });
      }

      return res.status(200).json({ reply: data.choices[0].message.content });
    }

    // --- Plugins path (tool calling) ---
    // Only taken when Plugins is explicitly on. Everything below this
    // block (Think Harder path, normal chat path) is completely untouched
    // and behaves exactly as before when usePlugins is false.
    if (usePlugins) {
      const pluginMaxTokens = useThinkHarder ? 1500 : 600;

      let decisionResult = null;
      let workingModel = null;
      let lastError = null;

      for (const model of PLUGIN_MODELS) {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: model,
            messages: finalMessages,
            max_tokens: pluginMaxTokens,
            tools: TOOLS,
            tool_choice: "auto"
          })
        });

        const result = await response.json();

        if (!result.error && result.choices?.[0]?.message) {
          decisionResult = result;
          workingModel = model;
          console.log("Used plugin-capable model:", model);
          break;
        }

        lastError = result.error?.message || "Unknown error";
        console.log(`Plugin model ${model} failed:`, lastError);
      }

      if (!decisionResult) {
        // No tools-capable model available today — degrade gracefully to
        // a normal answer rather than erroring the whole request out.
        console.log("No plugin-capable model available, falling back to normal chat:", lastError);

        let upstreamResponse = null;
        for (const model of FREE_MODELS) {
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: model,
              messages: finalMessages,
              max_tokens: pluginMaxTokens,
              stream: true
            })
          });

          if (response.ok) {
            upstreamResponse = response;
            console.log("Streaming with model:", model, "(plugins fallback, no tools)");
            break;
          }

          const errJson = await response.json().catch(() => null);
          lastError = errJson?.error?.message || `HTTP ${response.status}`;
          console.log(`Model ${model} failed:`, lastError);
        }

        if (!upstreamResponse) {
          return res.status(500).json({ error: "All models unavailable: " + lastError });
        }

        return pipeStreamToResponse(res, upstreamResponse);
      }

      const assistantMessage = decisionResult.choices[0].message;
      const toolCalls = assistantMessage.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // Model answered directly without needing a tool — this is already
        // the final answer.
        const directAnswer = assistantMessage.content || "(No reply received)";
        return writeSyntheticStream(res, directAnswer);
      }

      // Execute each requested tool server-side (whitelisted, read-only,
      // no eval — see executeTool/safeCalculate above), then ask the model
      // for its final answer using the tool results.
      const toolResultMessages = toolCalls.map(function(call) {
        const resultJson = executeTool(call.function.name, call.function.arguments);
        return {
          role: "tool",
          tool_call_id: call.id,
          content: resultJson
        };
      });

      const followUpMessages = finalMessages.concat([assistantMessage], toolResultMessages);

      const followUpResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: workingModel,
          messages: followUpMessages,
          max_tokens: pluginMaxTokens,
          stream: true
        })
      });

      if (!followUpResponse.ok) {
        const errJson = await followUpResponse.json().catch(() => null);
        const followUpError = errJson?.error?.message || `HTTP ${followUpResponse.status}`;
        console.log("Plugin follow-up call failed:", followUpError);
        return res.status(500).json({ error: "Tool result follow-up failed: " + followUpError });
      }

      console.log("Streaming final answer with tool results using:", workingModel);
      return pipeStreamToResponse(res, followUpResponse);
    }

    // --- Text path (normal chat + Think Harder) ---
    // When Think Harder is off (the default, overwhelmingly common case),
    // textModelList/textMaxTokens below evaluate to exactly what this
    // endpoint has always used — normal chat is unaffected by any of this.
    let textModelList = FREE_MODELS;
    let textMaxTokens = 600;

    let upstreamResponse = null;
    let lastError = null;

    if (useThinkHarder) {
      // Try the dedicated reasoning-capable model first, with the
      // reasoning effort parameter set and a much larger token budget so
      // the model has room to actually reason before answering.
      for (const model of THINK_MODELS) {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: model,
            messages: finalMessages,
            max_tokens: 2000,
            reasoning: { effort: "high" },
            stream: true
          })
        });

        if (response.ok) {
          upstreamResponse = response;
          console.log("Streaming with model:", model, "(think harder)");
          break;
        }

        const errJson = await response.json().catch(() => null);
        lastError = errJson?.error?.message || `HTTP ${response.status}`;
        console.log(`Think Harder model ${model} failed:`, lastError);
      }

      if (!upstreamResponse) {
        // Reasoning-dedicated model unavailable — fall back to the normal
        // free model list, but keep the stronger prompt and a larger token
        // budget so Think Harder still provides real value even here.
        textModelList = FREE_MODELS;
        textMaxTokens = 1500;
      }
    }

    if (!upstreamResponse) {
      for (const model of textModelList) {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: model,
            messages: finalMessages,
            max_tokens: textMaxTokens,
            stream: true
          })
        });

        if (response.ok) {
          upstreamResponse = response;
          console.log("Streaming with model:", model, useThinkHarder ? "(think harder fallback)" : "(text)");
          break;
        }

        const errJson = await response.json().catch(() => null);
        lastError = errJson?.error?.message || `HTTP ${response.status}`;
        console.log(`Model ${model} failed:`, lastError);
      }
    }

    if (!upstreamResponse) {
      return res.status(500).json({ error: "All models unavailable: " + lastError });
    }

    return pipeStreamToResponse(res, upstreamResponse);

  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
}
