/**
 * Brave Search integration for Cecil.
 * Provides web search capability via [WEBSEARCH: query] markers.
 */

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY || "";
const MAX_RESULTS = 5;
const TIMEOUT_MS = 10000;

interface BraveResult {
  title: string;
  url: string;
  description: string;
}

interface WebSearchResult {
  query: string;
  results: BraveResult[];
  formattedContext: string;
}

export async function webSearch(query: string): Promise<WebSearchResult> {
  if (!BRAVE_API_KEY) {
    console.error("[web-search] No BRAVE_SEARCH_API_KEY set");
    return { query, results: [], formattedContext: "" };
  }

  const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[web-search] Brave API error: ${res.status}`);
      return { query, results: [], formattedContext: "" };
    }

    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    const results: BraveResult[] = (data.web?.results || [])
      .slice(0, MAX_RESULTS)
      .map((r) => ({
        title: r.title || "",
        url: r.url || "",
        description: r.description || "",
      }));

    const formattedContext = results.length > 0
      ? results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.description}\n   Source: ${r.url}`)
          .join("\n\n")
      : "";

    console.log(`[web-search] "${query}" → ${results.length} results`);

    return { query, results, formattedContext };
  } catch (err) {
    console.error("[web-search] Failed:", err);
    return { query, results: [], formattedContext: "" };
  } finally {
    clearTimeout(timeout);
  }
}
