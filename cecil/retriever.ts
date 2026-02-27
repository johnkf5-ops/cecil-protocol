import { getQdrantClient, COLLECTION_NAME, embedText } from "./embedder";
import type { MemoryType, SearchResult, MemoryMetadata } from "./types";

interface SearchOptions {
  limit?: number;
  scoreThreshold?: number;
  filter?: Record<string, unknown>;
}

export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 10, scoreThreshold = 0.5, filter } = options;
  const client = getQdrantClient();
  const vector = await embedText(query);

  const results = await client.search(COLLECTION_NAME, {
    vector,
    limit,
    score_threshold: scoreThreshold,
    ...(filter ? { filter: { must: toQdrantFilter(filter) } } : {}),
    with_payload: true,
  });

  return results.map((r) => ({
    id: String(r.id),
    text: (r.payload?.text as string) || "",
    score: r.score,
    metadata: {
      type: (r.payload?.type as MemoryType) || "conversation",
      timestamp: (r.payload?.timestamp as string) || "",
      sessionId: (r.payload?.session_id as string) || undefined,
      sourcePath: (r.payload?.source_path as string) || undefined,
    },
  }));
}

export async function searchByType(
  query: string,
  type: MemoryType,
  limit = 10,
  scoreThreshold = 0.5
): Promise<SearchResult[]> {
  return search(query, {
    limit,
    scoreThreshold,
    filter: { type },
  });
}

export async function getRecentByType(
  type: MemoryType,
  limit = 20
): Promise<SearchResult[]> {
  const client = getQdrantClient();

  const results = await client.scroll(COLLECTION_NAME, {
    filter: {
      must: [{ key: "type", match: { value: type } }],
    },
    limit,
    with_payload: true,
    with_vector: false,
  });

  return results.points
    .map((r) => ({
      id: String(r.id),
      text: (r.payload?.text as string) || "",
      score: 1,
      metadata: {
        type: (r.payload?.type as MemoryType) || type,
        timestamp: (r.payload?.timestamp as string) || "",
        sessionId: (r.payload?.session_id as string) || undefined,
        sourcePath: (r.payload?.source_path as string) || undefined,
      } as MemoryMetadata,
    }))
    .sort(
      (a, b) =>
        new Date(b.metadata.timestamp).getTime() -
        new Date(a.metadata.timestamp).getTime()
    );
}

function toQdrantFilter(
  filter: Record<string, unknown>
): { key: string; match: { value: unknown } }[] {
  return Object.entries(filter).map(([key, value]) => ({
    key,
    match: { value },
  }));
}
