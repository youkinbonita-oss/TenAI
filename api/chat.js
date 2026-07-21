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

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages: finalMessages
      })
    });

    const data = await response.json();

    console.log(JSON.stringify(data, null, 2));

    if (data.error) {
      return res.status(500).json({ error: data.error.message || "OpenRouter error" });
    }

    const reply =
      data.choices?.[0]?.message?.content ||
      JSON.stringify(data);

    res.status(200).json({ reply });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
