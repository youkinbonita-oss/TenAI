async function performTavilySearch(query, apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, 7000);

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "advanced",
        topic: "general",
        max_results: 10,
        include_answer: true,
        include_raw_content: true,
        include_images: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(function () { return ""; });
      console.error("Tavily search failed:", response.status, errText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Tavily request error:", error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function mapResults(data) {
  const rawResults = Array.isArray(data && data.results) ? data.results : [];

  return rawResults
    .filter(function (r) { return r && r.title && r.url; })
    .slice(0, 10)
    .map(function (r) {
      return {
        title: r.title,
        url: r.url,
        snippet: r.content || ""
      };
    });
}

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

    const trimmedQuery = query.trim();
    const apiKey = process.env.TAVILY_API_KEY;

    // Try the exact quoted phrase first — this catches specific names and
    // multi-word terms (e.g. "Marley Fedexz") that a loose keyword search
    // can otherwise dilute or miss entirely.
    const quotedQuery = '"' + trimmedQuery + '"';
    let data = await performTavilySearch(quotedQuery, apiKey);
    let results = mapResults(data);

    // Fall back to a normal, unquoted search if the exact phrase came back
    // empty (too strict) or the request itself failed.
    if (results.length === 0) {
      data = await performTavilySearch(trimmedQuery, apiKey);
      results = mapResults(data);
    }

    return res.status(200).json({ results: results });

  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({ error: error.message });
  }
}
