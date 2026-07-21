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
  "meta-llama/llama-3.3-70b-instruct:free"
];

const VISION_MODELS = [
  "openrouter/free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free"
];

function messagesContainImage(messages) {
  return messages.some(function(m) {
    return Array.isArray(m.content) && m.content.some(function(part) {
      return part.type === "image_url";
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message, messages, image } = req.body || {};

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

    const hasImage = messagesContainImage(finalMessages) || typeof image === "string";

    finalMessages = [
      { role: "system", content: "You are TenAI, a helpful assistant. Reply naturally and directly to the user's question. If an image is provided, describe and answer questions about it accurately." },
      ...finalMessages
    ];

    const modelList = hasImage ? VISION_MODELS : FREE_MODELS;

    let upstreamResponse = null;
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
          max_tokens: 600,
          stream: true
        })
      });

      if (response.ok) {
        upstreamResponse = response;
        console.log("Streaming with model:", model, hasImage ? "(vision)" : "(text)");
        break;
      }

      const errJson = await response.json().catch(() => null);
      lastError = errJson?.error?.message || `HTTP ${response.status}`;
      console.log(`Model ${model} failed:`, lastError);
    }

    if (!upstreamResponse) {
      return res.status(500).json({ error: "All models unavailable: " + lastError });
    }

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

  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
}
