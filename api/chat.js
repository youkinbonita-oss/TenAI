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

function lastMessageHasImage(messages) {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];

  return Array.isArray(last.content) &&
    last.content.some(function(part) {
      return part.type === "image_url";
    });
}

// ---------- TenAI Plugins: safe calculator ----------
function calculateExpression(expression) {
  const input = String(expression || "").trim();

  if (!input || input.length > 200) {
    throw new Error("Invalid calculation.");
  }

  if (!/^[0-9+\-*/().\s%]+$/.test(input)) {
    throw new Error(
      "Calculator supports numbers and basic arithmetic only."
    );
  }

  const tokens = input.match(
    /(?:\d+(?:\.\d*)?|\.\d+|[()+\-*/%])/g
  );

  if (!tokens ||
      tokens.join("") !== input.replace(/\s+/g, "")) {
    throw new Error("Invalid calculation.");
  }

  let pos = 0;

  function parseExpression() {
    let value = parseTerm();

    while (tokens[pos] === "+" || tokens[pos] === "-") {
      const op = tokens[pos++];
      const rhs = parseTerm();

      value = op === "+"
        ? value + rhs
        : value - rhs;
    }

    return value;
  }

  function parseTerm() {
    let value = parseUnary();

    while (
      tokens[pos] === "*" ||
      tokens[pos] === "/" ||
      tokens[pos] === "%"
    ) {
      const op = tokens[pos++];
      const rhs = parseUnary();

      if ((op === "/" || op === "%") && rhs === 0) {
        throw new Error("Cannot divide by zero.");
      }

      value =
        op === "*"
          ? value * rhs
          : op === "/"
            ? value / rhs
            : value % rhs;
    }

    return value;
  }

  function parseUnary() {
    if (tokens[pos] === "+") {
      pos++;
      return parseUnary();
    }

    if (tokens[pos] === "-") {
      pos++;
      return -parseUnary();
    }

    return parsePrimary();
  }

  function parsePrimary() {
    if (tokens[pos] === "(") {
      pos++;

      const value = parseExpression();

      if (tokens[pos++] !== ")") {
        throw new Error("Invalid calculation.");
      }

      return value;
    }

    const token = tokens[pos++];

    if (
      !token ||
      !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)
    ) {
      throw new Error("Invalid calculation.");
    }

    const value = Number(token);

    if (!Number.isFinite(value)) {
      throw new Error("Invalid calculation.");
    }

    return value;
  }

  const result = parseExpression();

  if (pos !== tokens.length || !Number.isFinite(result)) {
    throw new Error("Invalid calculation.");
  }

  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const {
      message,
      messages,
      image,
      plugins
    } = req.body || {};

    const pluginsEnabled = plugins === true;

    let finalMessages = Array.isArray(messages)
      ? messages
      : [];

    finalMessages = finalMessages
      .filter(function(m) {
        if (!m) return false;

        if (typeof m.content === "string") {
          return m.content.trim().length > 0;
        }

        if (Array.isArray(m.content)) {
          return m.content.length > 0;
        }

        return false;
      })
      .map(function(m) {
        return {
          role:
            m.role === "ai" ||
            m.role === "assistant"
              ? "assistant"
              : "user",
          content: m.content
        };
      });

    if (
      finalMessages.length === 0 &&
      typeof message === "string" &&
      message.trim().length > 0
    ) {
      finalMessages = [
        {
          role: "user",
          content: message
        }
      ];
    }

    if (finalMessages.length === 0) {
      return res.status(400).json({
        error: "No message content provided"
      });
    }

    // Calculator plugin: one-shot, server-side, no eval().
    if (
      pluginsEnabled &&
      typeof message === "string"
    ) {
      const calculatorMatch = message.match(
        /(?:calculate|compute|what is|solve)\s*[:=]?\s*([0-9+\-*/().%\s]{1,200})$/i
      );

      if (calculatorMatch) {
        try {
          const result = calculateExpression(
            calculatorMatch[1]
          );

          return res.status(200).json({
            reply: `The answer is ${result}.`,
            plugin: "calculator"
          });
        } catch (error) {
          return res.status(400).json({
            error: error.message
          });
        }
      }
    }

    const hasImage =
      lastMessageHasImage(finalMessages) ||
      typeof image === "string";

    finalMessages = [
      {
        role: "system",
        content:
          "You are TenAI, a helpful assistant. Always reply in natural conversational language, never in a labeled or classifier-style format such as 'User Safety: safe'. When an image is provided, immediately describe what is in the image in plain language, then answer any question the user asked about it."
      },
      ...finalMessages
    ];

    const modelList = hasImage
      ? VISION_MODELS
      : FREE_MODELS;

    if (hasImage) {
      let data = null;
      let lastError = null;

      for (const model of modelList) {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Authorization":
                `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              model: model,
              messages: finalMessages,
              max_tokens: 450
            })
          }
        );

        const result = await response.json();

        if (
          !result.error &&
          result.choices?.[0]?.message?.content
        ) {
          data = result;

          console.log(
            "Used vision model (non-streaming):",
            model
          );

          break;
        }

        lastError =
          result.error?.message ||
          "Unknown error";

        console.log(
          `Vision model ${model} failed:`,
          lastError
        );
      }

      if (!data) {
        return res.status(500).json({
          error:
            "All vision models unavailable: " +
            lastError
        });
      }

      return res.status(200).json({
        reply:
          data.choices[0].message.content
      });
    }

    let upstreamResponse = null;
    let lastError = null;

    for (const model of modelList) {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization":
              `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            model: model,
            messages: finalMessages,
            max_tokens: 600,
            stream: true
          })
        }
      );

      if (response.ok) {
        upstreamResponse = response;

        console.log(
          "Streaming with model:",
          model,
          "(text)"
        );

        break;
      }

      const errJson =
        await response.json().catch(() => null);

      lastError =
        errJson?.error?.message ||
        `HTTP ${response.status}`;

      console.log(
        `Model ${model} failed:`,
        lastError
      );
    }

    if (!upstreamResponse) {
      return res.status(500).json({
        error:
          "All models unavailable: " +
          lastError
      });
    }

    res.writeHead(200, {
      "Content-Type":
        "text/event-stream",
      "Cache-Control":
        "no-cache, no-transform",
      "Connection":
        "keep-alive"
    });

    const reader =
      upstreamResponse.body.getReader();

    const decoder = new TextDecoder();

    while (true) {
      const {
        done,
        value
      } = await reader.read();

      if (done) break;

      res.write(
        decoder.decode(value, {
          stream: true
        })
      );
    }

    res.end();

  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      res.status(500).json({
        error: error.message
      });
    } else {
      res.end();
    }
  }
}
