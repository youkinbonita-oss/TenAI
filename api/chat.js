const FREE_MODELS = [
  "openai/gpt-oss-120b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-235b-a22b:free"
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message, messages } = req.body || {};

    let finalMessages = Array.isArray(messages) ? messages : [];

    finalMessages = finalMessages
      .filter(m => m && typeof m.content === "string" && m.content.trim().length > 0)
      .map(m => ({
        role: m.role === "ai" || m.role === "assistant" ? "assistant" : "user",
        content: m.content
      }));

    if (finalMessages.length === 0 && typeof message === "string" && message.trim().length > 0) {
      finalMessages = [{ role: "user", content: message }];
    }

    if (finalMessages.length === 0) {
      return res.status(400).json({ error: "No message content provided" });
    }

    finalMessages = [
      { role: "system", content: "You are TenAI, a helpful assistant. Reply naturally and directly to the user's question." },
      ...finalMessages
    ];

    let data = null;
    let lastError = null;

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
          max_tokens: 500
        })
      });

      const result = await response.json();

      if (!result.error && result.choices?.[0]?.message?.content) {
        data = result;
        console.log("Used model:", model);
        break;
      }

      lastError = result.error?.message || "Unknown error";
      console.log(`Model ${model} failed:`, lastError);
    }

    if (!data) {
      return res.status(500).json({ error: "All models unavailable: " + lastError });
    }

    const reply = data.choices[0].message.content;
    res.status(200).json({ reply });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
