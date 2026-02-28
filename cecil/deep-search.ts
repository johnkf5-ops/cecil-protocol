import { searchByType } from "./retriever";
import type { MemoryType, SearchResult } from "./types";

export interface DeepSearchResult {
  query: string;
  results: SearchResult[];
  formattedContext: string;
}

/**
 * Execute a deep search across all memory types.
 * Searches podcast, fact, and observation vectors in parallel,
 * merges/dedupes by ID, and returns top 25 results formatted
 * as context ready to inject into a follow-up prompt.
 */
export async function deepSearch(query: string): Promise<DeepSearchResult> {
  const [podcastResults, factResults, observationResults] = await Promise.all([
    searchByType(query, "podcast", 20, 0.2),
    searchByType(query, "fact" as MemoryType, 15, 0.3),
    searchByType(query, "observation", 10, 0.3),
  ]);

  // Merge and deduplicate by ID, sort by score descending
  const all = [...factResults, ...podcastResults, ...observationResults];
  const seen = new Set<string>();
  const deduped = all.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  deduped.sort((a, b) => b.score - a.score);

  const top = deduped.slice(0, 25);

  // Format by type for clarity in the prompt
  const facts = top.filter((r) => r.metadata.type === "fact");
  const podcasts = top.filter((r) => r.metadata.type === "podcast");
  const observations = top.filter((r) => r.metadata.type === "observation");

  const sections: string[] = [];

  if (facts.length > 0) {
    sections.push(
      "**Extracted facts:**\n" + facts.map((r) => `- ${r.text}`).join("\n")
    );
  }
  if (podcasts.length > 0) {
    sections.push(
      "**Podcast excerpts:**\n" +
        podcasts.map((r) => `- ${r.text.slice(0, 1000)}`).join("\n")
    );
  }
  if (observations.length > 0) {
    sections.push(
      "**Observations:**\n" +
        observations.map((r) => `- ${r.text.slice(0, 500)}`).join("\n")
    );
  }

  return {
    query,
    results: top,
    formattedContext: sections.join("\n\n"),
  };
}
