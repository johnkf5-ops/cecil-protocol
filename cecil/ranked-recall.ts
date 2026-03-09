import {
  getCurrentMemories,
  getMemoryEvents,
  getRankedRecallCandidates,
} from "./memory-store";
import type { MemoryType } from "./types";

const DEFAULT_RECALL_TYPES: MemoryType[] = [
  "seed",
  "conversation",
  "observation",
  "fact",
  "podcast",
  "milestone",
];

export interface RankedRecallOptions {
  types?: MemoryType[];
  limit?: number;
}

export interface RankedRecallBundle {
  candidates: Awaited<ReturnType<typeof getRankedRecallCandidates>>;
  recentState: Awaited<ReturnType<typeof getCurrentMemories>>;
  recentEvents: Awaited<ReturnType<typeof getMemoryEvents>>;
}

export async function collectRankedRecallBundle(
  query: string,
  options: RankedRecallOptions = {}
): Promise<RankedRecallBundle> {
  const types = options.types ?? DEFAULT_RECALL_TYPES;
  const limit = options.limit ?? 12;

  const candidates = await getRankedRecallCandidates(query, {
    types,
    limit,
  });

  // Avoid polluting query-driven recall with purely recent records that
  // did not match the query. We only surface recent state/events for keys
  // that already ranked as relevant candidates.
  const candidateKeys = new Set(candidates.map((candidate) => candidate.memoryKey));

  const [recentState, recentEvents] = await Promise.all([
    getCurrentMemories({
      types,
      limit: Math.max(limit * 3, 24),
    }).then((rows) => rows.filter((row) => candidateKeys.has(row.memoryKey))),
    getMemoryEvents({
      types,
      limit: Math.max(limit * 4, 48),
    }).then((rows) => rows.filter((row) => candidateKeys.has(row.memoryKey))),
  ]);

  return {
    candidates,
    recentState,
    recentEvents,
  };
}
