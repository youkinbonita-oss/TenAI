export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages } = req.body;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openrouter/free",
       messages: messages

          }
        ]
      })
    });

    
const data = await response.json();

console.log("OPENROUTER RESPONSE:", JSON.stringify(data, null, 2));
    
const reply =
  data.choices?.[0]?.message?.content ||
  JSON.stringify(data);

    res.status(200).json({ reply });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
