import { collectRankedRecallBundle } from "./ranked-recall";
import { search, searchByType } from "./retriever";
import type { MemoryType, SearchResult } from "./types";

const DEFAULT_RECALL_TYPES: MemoryType[] = [
  "conversation",
  "observation",
  "fact",
  "milestone",
];

const TYPE_LABELS: Record<MemoryType, string> = {
  conversation: "CONVERSATIONS",
  observation: "OBSERVATIONS",
  fact: "FACTS",
  podcast: "PODCASTS",
  milestone: "MILESTONES",
  seed: "SEED",
};

const TYPE_CHAR_LIMITS: Record<MemoryType, number> = {
  conversation: 260,
  observation: 260,
  fact: 220,
  podcast: 360,
  milestone: 220,
  seed: 220,
};

const TYPE_ITEM_LIMITS: Record<MemoryType, number> = {
  conversation: 2,
  observation: 3,
  fact: 4,
  podcast: 3,
  milestone: 2,
  seed: 0,
};

const TYPE_TOKEN_BUDGETS: Record<MemoryType, number> = {
  conversation: 180,
  observation: 220,
  fact: 280,
  podcast: 320,
  milestone: 160,
  seed: 0,
};

const TOTAL_RECALL_TOKEN_BUDGET = 900;

const IDENTITY_QUERY_TOKENS = new Set([
  "believe",
  "belief",
  "care",
  "cares",
  "important",
  "matters",
  "priorities",
  "priority",
  "value",
  "values",
]);

type RecallSource =
  | "structured_candidate"
  | "structured_current"
  | "structured_event"
  | "qdrant";

interface RecallSnippet {
  dedupeKey: string;
  memoryType: MemoryType;
  text: string;
  excerpt: string;
  sourceLabel: string;
  timestamp?: string;
  score: number;
  estimatedTokens: number;
  source: RecallSource;
}

export interface RecallWindow {
  formattedContext: string;
  snippets: RecallSnippet[];
}

export interface RecallWindowOptions {
  types?: MemoryType[];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}

function isIdentityValueQuery(query: string): boolean {
  const normalized = normalizeText(query);
  const hasIdentityToken = Array.from(IDENTITY_QUERY_TOKENS).some((token) =>
    normalized.includes(token)
  );

  return hasIdentityToken;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function computeRecencyBoost(timestamp?: string): number {
  if (!timestamp) {
    return 0;
  }

  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 0;
  }

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 1) return 0.35;
  if (ageDays <= 7) return 0.25;
  if (ageDays <= 30) return 0.15;
  if (ageDays <= 90) return 0.08;
  return 0.02;
}

const EVIDENCE_GUIDE = [
  "=== EVIDENCE GUIDE ===",
  "- SEED_STATED: directly supplied during onboarding; highest confidence.",
  "- PUBLIC_CORPUS_FACT: extracted from public podcast material; useful evidence, but transcript extraction can be noisy.",
  "- PUBLIC_CORPUS_INFERENCE: synthesized from repeated public material; useful, but not private truth.",
  "- PRIVATE_CONVERSATION: drawn from direct conversation history.",
  "- If no tier gives solid support, answer that it is not known.",
].join("\n");

function getConfidenceBand(value: unknown, qualityScore?: number): string | null {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  if (typeof qualityScore !== "number") {
    return null;
  }

  if (qualityScore >= 0.94) {
    return "high";
  }

  if (qualityScore >= 0.86) {
    return "medium";
  }

  return "low";
}

function getEvidenceTier(params: {
  memoryType: MemoryType;
  sourceType?: string;
  provenance?: Record<string, unknown>;
}): string {
  const knowledgeScope =
    typeof params.provenance?.knowledgeScope === "string"
      ? params.provenance.knowledgeScope
      : "";
  const epistemicStatus =
    typeof params.provenance?.epistemicStatus === "string"
      ? params.provenance.epistemicStatus
      : "";
  const observationKind =
    typeof params.provenance?.observationKind === "string"
      ? params.provenance.observationKind
      : "";

  if (epistemicStatus === "seed_stated" || knowledgeScope === "seed") {
    return "SEED_STATED";
  }

  if (params.sourceType === "onboarding" && observationKind === "profile") {
    return "SEED_STATED";
  }

  if (params.sourceType === "fact_extraction") {
    return "PUBLIC_CORPUS_FACT";
  }

  if (epistemicStatus === "public_corpus_inference" || knowledgeScope === "public_corpus") {
    return "PUBLIC_CORPUS_INFERENCE";
  }

  if (params.sourceType === "conversation_session") {
    return "PRIVATE_CONVERSATION";
  }

  return params.memoryType === "observation" ? "DERIVED_MEMORY" : "MEMORY_RECORD";
}

function buildSourceLabel(params: {
  memoryType: MemoryType;
  sourceType?: string;
  provenance?: Record<string, unknown>;
  qualityScore?: number;
  sourceEpisode?: string;
  sourcePath?: string;
  timestamp?: string;
}): string {
  const evidenceTier = getEvidenceTier({
    memoryType: params.memoryType,
    sourceType: params.sourceType,
    provenance: params.provenance,
  });
  const confidenceBand = getConfidenceBand(
    params.provenance?.confidenceBand,
    params.qualityScore
  );
  const bits: string[] = [evidenceTier];

  if (evidenceTier === "PUBLIC_CORPUS_INFERENCE" && confidenceBand) {
    bits.push(`${confidenceBand}_confidence`);
  }

  bits.push(params.memoryType);

  if (params.sourceEpisode) {
    bits.push(params.sourceEpisode);
  } else if (params.sourcePath) {
    bits.push(params.sourcePath);
  }

  if (params.timestamp) {
    bits.push(params.timestamp);
  }

  return bits.join(" | ");
}

function fromSearchResult(result: SearchResult): RecallSnippet {
  const excerpt = clipText(
    result.text,
    TYPE_CHAR_LIMITS[result.metadata.type] ?? 240
  );

  return {
    dedupeKey: normalizeText(result.text).slice(0, 220),
    memoryType: result.metadata.type,
    text: result.text,
    excerpt,
    sourceLabel: buildSourceLabel({
      memoryType: result.metadata.type,
      sourceType: result.metadata.sourceType,
      provenance: result.metadata.provenance,
      qualityScore: result.metadata.qualityScore,
      sourceEpisode: result.metadata.sourceEpisode,
      sourcePath: result.metadata.sourcePath,
      timestamp: result.metadata.timestamp,
    }),
    timestamp: result.metadata.timestamp,
    score:
      result.score * 2 +
      (result.metadata.qualityScore ?? 0.5) +
      computeRecencyBoost(result.metadata.timestamp),
    estimatedTokens: estimateTokens(excerpt),
    source: "qdrant",
  };
}

function formatSection(memoryType: MemoryType, snippets: RecallSnippet[]): string {
  return (
    `=== RECALL ${TYPE_LABELS[memoryType]} ===\n` +
    snippets
      .map((snippet) => `- [${snippet.sourceLabel}] ${snippet.excerpt}`)
      .join("\n")
  );
}

export async function buildRecallWindow(
  query: string,
  options: RecallWindowOptions = {}
): Promise<RecallWindow> {
  const types = options.types ?? DEFAULT_RECALL_TYPES;
  const includeObservation = types.includes("observation");
  const includeFact = types.includes("fact");
  const includePodcast = types.includes("podcast");

  const [structured, observationResults, factResults, podcastResults] =
    await Promise.all([
      collectRankedRecallBundle(query, {
        types,
        limit: 10,
      }),
      includeObservation
        ? search(query, {
            limit: 8,
            scoreThreshold: 0.4,
            filter: { type: "observation" },
          })
        : Promise.resolve([]),
      includeFact ? searchByType(query, "fact", 8, 0.25) : Promise.resolve([]),
      includePodcast
        ? searchByType(query, "podcast", 6, 0.3)
        : Promise.resolve([]),
    ]);

  const structuredCandidateSnippets: RecallSnippet[] = structured.candidates.map(
    (item) => {
      const excerpt = clipText(item.text, TYPE_CHAR_LIMITS[item.memoryType] ?? 240);

      return {
        dedupeKey: normalizeText(item.text).slice(0, 220),
        memoryType: item.memoryType,
        text: item.text,
        excerpt,
        sourceLabel: buildSourceLabel({
          memoryType: item.memoryType,
          sourceType: item.sourceType,
          provenance: item.provenance,
          qualityScore: item.qualityScore,
          sourceEpisode: item.sourceEpisode,
          sourcePath: item.sourcePath,
          timestamp: item.updatedAt,
        }),
        timestamp: item.updatedAt,
        score: item.recallScore + computeRecencyBoost(item.updatedAt) + 0.25,
        estimatedTokens: estimateTokens(excerpt),
        source: "structured_candidate",
      };
    }
  );

  const structuredCurrentSnippets: RecallSnippet[] = structured.recentState.map(
    (item) => {
      const excerpt = clipText(item.text, TYPE_CHAR_LIMITS[item.memoryType] ?? 240);

      return {
        dedupeKey: normalizeText(item.text).slice(0, 220),
        memoryType: item.memoryType,
        text: item.text,
        excerpt,
        sourceLabel: buildSourceLabel({
          memoryType: item.memoryType,
          sourceType: item.sourceType,
          provenance: item.provenance,
          qualityScore: item.qualityScore,
          sourceEpisode: item.sourceEpisode,
          sourcePath: item.sourcePath,
          timestamp: item.updatedAt,
        }),
        timestamp: item.updatedAt,
        score: item.qualityScore + computeRecencyBoost(item.updatedAt) + 0.12,
        estimatedTokens: estimateTokens(excerpt),
        source: "structured_current",
      };
    }
  );

  const structuredEventSnippets: RecallSnippet[] = structured.recentEvents.map(
    (item) => {
      const excerpt = clipText(item.text, TYPE_CHAR_LIMITS[item.memoryType] ?? 240);

      return {
        dedupeKey: normalizeText(item.text).slice(0, 220),
        memoryType: item.memoryType,
        text: item.text,
        excerpt,
        sourceLabel: buildSourceLabel({
          memoryType: item.memoryType,
          sourceType: item.sourceType,
          provenance: item.provenance,
          qualityScore: item.qualityScore,
          sourceEpisode: item.sourceEpisode,
          sourcePath: item.sourcePath,
          timestamp: item.createdAt,
        }),
        timestamp: item.createdAt,
        score: item.qualityScore + computeRecencyBoost(item.createdAt) + 0.08,
        estimatedTokens: estimateTokens(excerpt),
        source: "structured_event",
      };
    }
  );

  const allSnippets = [
    ...structuredCandidateSnippets,
    ...structuredCurrentSnippets,
    ...structuredEventSnippets,
    ...observationResults.map(fromSearchResult),
    ...factResults.map(fromSearchResult),
    ...podcastResults.map(fromSearchResult),
  ]
    .filter((snippet) => snippet.memoryType !== "seed")
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return (
        new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()
      );
    });

  const seen = new Set<string>();
  const perTypeCounts = new Map<MemoryType, number>();
  const perTypeTokens = new Map<MemoryType, number>();
  const selected: RecallSnippet[] = [];
  let remainingTokens = TOTAL_RECALL_TOKEN_BUDGET;

  for (const snippet of allSnippets) {
    if (seen.has(snippet.dedupeKey)) {
      continue;
    }

    const typeCount = perTypeCounts.get(snippet.memoryType) ?? 0;
    const typeTokenCount = perTypeTokens.get(snippet.memoryType) ?? 0;
    const typeItemLimit = TYPE_ITEM_LIMITS[snippet.memoryType] ?? 2;
    const typeTokenBudget = TYPE_TOKEN_BUDGETS[snippet.memoryType] ?? 160;

    if (typeCount >= typeItemLimit) {
      continue;
    }

    if (typeTokenCount + snippet.estimatedTokens > typeTokenBudget) {
      continue;
    }

    if (snippet.estimatedTokens > remainingTokens) {
      continue;
    }

    selected.push(snippet);
    seen.add(snippet.dedupeKey);
    perTypeCounts.set(snippet.memoryType, typeCount + 1);
    perTypeTokens.set(snippet.memoryType, typeTokenCount + snippet.estimatedTokens);
    remainingTokens -= snippet.estimatedTokens;
  }

  const orderedTypes = (
    isIdentityValueQuery(query)
      ? ["observation", "fact", "milestone", "conversation", "podcast"]
      : ["fact", "milestone", "observation", "conversation", "podcast"]
  ).filter((type): type is MemoryType => types.includes(type as MemoryType));

  const sections = orderedTypes
    .map((type) => {
      const snippets = selected.filter((snippet) => snippet.memoryType === type);
      return snippets.length > 0 ? formatSection(type, snippets) : null;
    })
    .filter((section): section is string => section !== null);

  return {
    formattedContext:
      sections.length > 0
        ? `${EVIDENCE_GUIDE}\n\n${sections.join("\n\n")}`
        : EVIDENCE_GUIDE,
    snippets: selected,
  };
}
