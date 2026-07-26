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

// Pulls the actual subject (usually a name) out of a question, so we search
// just "Marley Fedexz" instead of the whole sentence "Who is Marley
// Fedexz?" — quoting a full question almost never matches anything verbatim,
// which is what was forcing every search to fall back to a loose, diluted
// keyword search on the entire sentence.
function extractSearchSubject(query) {
  let subject = query.trim();

  const leadPhrases = [
    /^who\s+is\s+/i, /^who's\s+/i, /^who\s+are\s+/i,
    /^what\s+is\s+/i, /^what's\s+/i,
    /^where\s+is\s+/i, /^where's\s+/i,
    /^tell\s+me\s+about\s+/i,
    /^give\s+me\s+info(rmation)?\s+(on|about)\s+/i,
    /^information\s+(on|about)\s+/i,
    /^do\s+you\s+know\s+(who\s+)?/i,
    /^have\s+you\s+heard\s+of\s+/i
  ];

  for (let i = 0; i < leadPhrases.length; i++) {
    if (leadPhrases[i].test(subject)) {
      subject = subject.replace(leadPhrases[i], '');
      break;
    }
  }

  // Strip trailing punctuation and filler like "?", ".", "is he/she", etc.
  subject = subject.replace(/[?!.]+$/g, '').trim();

  // Only treat this as a "named subject" extraction if what's left is short
  // enough to plausibly be a name/entity (not a full leftover sentence) and
  // actually different from the original query. Otherwise, current-data
  // questions ("what's today's date", "latest news") pass through untouched.
  const wordCount = subject.split(/\s+/).filter(Boolean).length;
  const wasExtracted = subject.length > 0 && subject.toLowerCase() !== query.trim().toLowerCase();

  if (wasExtracted && wordCount >= 1 && wordCount <= 6) {
    return subject;
  }

  return null;
}

// Keeps only results that actually contain the searched name/subject, so a
// name like "Marley Fedexz" doesn't pull in unrelated results that only
// match one of the two words (e.g. Bob Marley, FedEx shipping).
function filterByRelevance(results, subject) {
  if (!subject) return results;

  const subjectLower = subject.toLowerCase();
  const words = subjectLower.split(/\s+/).filter(function (w) { return w.length > 1; });

  const exactPhraseMatches = results.filter(function (r) {
    const haystack = (r.title + ' ' + r.snippet).toLowerCase();
    return haystack.indexOf(subjectLower) !== -1;
  });

  if (exactPhraseMatches.length > 0) return exactPhraseMatches;

  if (words.length > 1) {
    const allWordsMatches = results.filter(function (r) {
      const haystack = (r.title + ' ' + r.snippet).toLowerCase();
      return words.every(function (w) { return haystack.indexOf(w) !== -1; });
    });

    if (allWordsMatches.length > 0) return allWordsMatches;
  }

  // Nothing matched strictly — return the unfiltered set rather than
  // nothing, so lesser-known artists with thin coverage still get results.
  return results;
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
    const subject = extractSearchSubject(trimmedQuery);

    let results = [];

    if (subject) {
      // Named-subject question (e.g. "Who is Marley Fedexz?") — search the
      // exact name first, then a loose search of just the name (still not
      // the full question) if the exact phrase came back empty.
      let data = await performTavilySearch('"' + subject + '"', apiKey);
      results = mapResults(data);

      if (results.length === 0) {
        data = await performTavilySearch(subject, apiKey);
        results = mapResults(data);
      }

      results = filterByRelevance(results, subject);
    } else {
      // Not a named-subject question (current date/time, weather, news,
      // sports results, etc.) — search the query as-is, unchanged from
      // before.
      const data = await performTavilySearch(trimmedQuery, apiKey);
      results = mapResults(data);
    }

    return res.status(200).json({ results: results });

  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({ error: error.message });
  }
}
