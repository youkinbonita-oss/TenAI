export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { query } = req.body || {};

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(400).json({ error: "No search query provided" });
    }

    const searchUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query.trim());

    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 8000);

    let response;
    try {
      response = await fetch(searchUrl, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return res.status(502).json({ error: "Search request failed with status " + response.status });
    }

    const html = await response.text();
    const results = parseDuckDuckGoHtml(html).slice(0, 5);

    return res.status(200).json({ results: results });

  } catch (error) {
    console.error("Search error:", error);
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "Search timed out" });
    }
    return res.status(500).json({ error: error.message });
  }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripTags(str) {
  return decodeHtmlEntities(str.replace(/<[^>]*>/g, "")).trim();
}

function resolveDuckDuckGoUrl(href) {
  try {
    if (href.indexOf("//duckduckgo.com/l/?") === 0) {
      const parsed = new URL("https:" + href);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    if (href.indexOf("/l/?") === 0) {
      const parsed = new URL("https://duckduckgo.com" + href);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    if (href.indexOf("//") === 0) {
      return "https:" + href;
    }
    return href;
  } catch (err) {
    return href;
  }
}

function parseDuckDuckGoHtml(html) {
  const results = [];

  const titleRegex = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titleMatches = [...html.matchAll(titleRegex)];
  const snippetMatches = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < titleMatches.length; i++) {
    const href = titleMatches[i][1];
    const title = stripTags(titleMatches[i][2]);
    const snippet = snippetMatches[i] ? stripTags(snippetMatches[i][1]) : "";
    const url = resolveDuckDuckGoUrl(href);

    if (title && url) {
      results.push({ title: title, url: url, snippet: snippet });
    }
  }

  return results;
}
