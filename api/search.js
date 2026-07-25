export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { query } = req.body || {};

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(400).json({ error: "No search query provided" });
    }

    if (!process.env.TAVILY_API_KEY) {
      console.error("TAVILY_API_KEY is not set");
      return res.status(500).json({ error: "Search is not configured" });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(function () { controller.abort(); }, 9000);

    let response;
    try {
      response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: query.trim(),
          search_depth: "basic",
          max_results: 5,
          include_answer: false
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errText = await response.text().catch(function () { return ""; });
      console.error("Tavily search failed:", response.status, errText);
      return res.status(502).json({ error: "Search request failed" });
    }

    const data = await response.json();
    const rawResults = Array.isArray(data.results) ? data.results : [];

    const results = rawResults
      .filter(function (r) { return r && r.title && r.url; })
      .slice(0, 5)
      .map(function (r) {
        return {
          title: r.title,
          url: r.url,
          snippet: r.content || ""
        };
      });

    return res.status(200).json({ results: results });

  } catch (error) {
    console.error("Search error:", error);
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "Search timed out" });
    }
    return res.status(500).json({ error: error.message });
  }
}
