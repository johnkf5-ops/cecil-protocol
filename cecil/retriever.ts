import { getQdrantClient, COLLECTION_NAME, embedText } from "./embedder";
import { getCurrentMemories } from "./memory-store";
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

  return results
    .filter((r) => {
      const prov = (r.payload as Record<string, unknown>)?.provenance as
        | Record<string, unknown>
        | undefined;
      return !prov?.retired;
    })
    .map((r) => {
    const payload = (r.payload || {}) as Record<string, unknown>;

    return {
      id: String(r.id),
      text: (payload.text as string) || "",
      score: r.score,
      metadata: {
        type: (payload.type as MemoryType) || "conversation",
        timestamp: (payload.timestamp as string) || "",
        sessionId:
          (payload.sessionId as string) ||
          (payload.session_id as string) ||
          undefined,
        sourcePath:
          (payload.sourcePath as string) ||
          (payload.source_path as string) ||
          undefined,
        sourceType:
          (payload.sourceType as MemoryMetadata["sourceType"]) ||
          (payload.source_type as MemoryMetadata["sourceType"]) ||
          undefined,
        sourceId:
          (payload.sourceId as string) ||
          (payload.source_id as string) ||
          undefined,
        sourceEpisode:
          (payload.sourceEpisode as string) ||
          (payload.source_episode as string) ||
          undefined,
        entities: Array.isArray(payload.entities)
          ? (payload.entities as string[])
          : undefined,
        category: (payload.category as string) || undefined,
        qualityScore:
          typeof payload.qualityScore === "number"
            ? (payload.qualityScore as number)
            : typeof payload.quality_score === "number"
              ? (payload.quality_score as number)
              : undefined,
        provenance:
          payload.provenance &&
          typeof payload.provenance === "object" &&
          !Array.isArray(payload.provenance)
            ? (payload.provenance as Record<string, unknown>)
            : undefined,
      },
    };
  });
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
  const currentRows = await getCurrentMemories({
    types: [type],
    limit,
  });

  if (currentRows.length > 0) {
    return currentRows.map((row) => ({
      id: row.memoryKey,
      text: row.text,
      score: 1,
      metadata: {
        type: row.memoryType,
        timestamp: row.updatedAt || row.createdAt,
        sessionId: row.sessionId,
        sourcePath: row.sourcePath,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceEpisode: row.sourceEpisode,
        entities: Array.isArray(row.provenance.entities)
          ? row.provenance.entities.filter(
              (value): value is string => typeof value === "string"
            )
          : undefined,
        category:
          typeof row.provenance.category === "string"
            ? row.provenance.category
            : undefined,
        qualityScore: row.qualityScore,
        provenance: row.provenance,
      },
    }));
  }

  const client = getQdrantClient();

  const fetchLimit = Math.max(limit * 5, 50);

  const results = await client.scroll(COLLECTION_NAME, {
    filter: {
      must: [{ key: "type", match: { value: type } }],
    },
    limit: fetchLimit,
    with_payload: true,
    with_vector: false,
  });

  return results.points
    .map((r) => {
      const payload = (r.payload || {}) as Record<string, unknown>;

      return {
        id: String(r.id),
        text: (payload.text as string) || "",
        score: 1,
        metadata: {
          type: (payload.type as MemoryType) || type,
          timestamp: (payload.timestamp as string) || "",
          sessionId:
            (payload.sessionId as string) ||
            (payload.session_id as string) ||
            undefined,
          sourcePath:
            (payload.sourcePath as string) ||
            (payload.source_path as string) ||
            undefined,
          sourceType:
            (payload.sourceType as MemoryMetadata["sourceType"]) ||
            (payload.source_type as MemoryMetadata["sourceType"]) ||
            undefined,
          sourceId:
            (payload.sourceId as string) ||
            (payload.source_id as string) ||
            undefined,
          sourceEpisode:
            (payload.sourceEpisode as string) ||
            (payload.source_episode as string) ||
            undefined,
          entities: Array.isArray(payload.entities)
            ? (payload.entities as string[])
            : undefined,
          category: (payload.category as string) || undefined,
          qualityScore:
            typeof payload.qualityScore === "number"
              ? (payload.qualityScore as number)
              : typeof payload.quality_score === "number"
                ? (payload.quality_score as number)
                : undefined,
          provenance:
            payload.provenance &&
            typeof payload.provenance === "object" &&
            !Array.isArray(payload.provenance)
              ? (payload.provenance as Record<string, unknown>)
              : undefined,
        } as MemoryMetadata,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.metadata.timestamp).getTime() -
        new Date(a.metadata.timestamp).getTime()
    )
    .slice(0, limit);
}

function toQdrantFilter(
  filter: Record<string, unknown>
): { key: string; match: { value: unknown } }[] {
  return Object.entries(filter).map(([key, value]) => ({
    key,
    match: { value },
  }));
}
