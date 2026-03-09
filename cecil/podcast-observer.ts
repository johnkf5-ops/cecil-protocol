import fs from "fs/promises";
import path from "path";
import { chatCompletion } from "./llm";
import { deletePointsByFilter, embed, embedBatch } from "./embedder";
import {
  getCurrentMemories,
  recordMemoryWrite,
  type StructuredMemoryRecord,
} from "./memory-store";
import { getRecentByType } from "./retriever";
import { synthesizeRelationshipObservations } from "./relationship-observer";
import { syncSeedProfileMemories } from "@/onboarding/seed-builder";

const IDENTITY_DIR = path.join(process.cwd(), "identity");
const OBSERVATIONS_DIR = path.join(process.cwd(), "memory", "observations");
const PODCAST_IDENTITY_SOURCE_PATH = "memory/observations/podcast-identity.md";
const PODCAST_IDENTITY_SOURCE_ID = "podcast-identity";

const IDENTITY_FACETS = [
  "values",
  "priorities",
  "beliefs",
  "preferences",
  "working_style",
  "communication_style",
  "tensions",
] as const;

type IdentityFacet = (typeof IDENTITY_FACETS)[number];

interface IdentityObservationCandidate {
  facet: IdentityFacet;
  text: string;
  evidence: string[];
  confidence?: number;
}

interface IdentityObservationResponseItem {
  facet?: unknown;
  text?: unknown;
  evidence?: unknown;
  confidence?: unknown;
}

const IDENTITY_FACET_LABELS: Record<IdentityFacet, string> = {
  values: "Values",
  priorities: "Priorities",
  beliefs: "Beliefs",
  preferences: "Preferences",
  working_style: "Working Style",
  communication_style: "Communication Style",
  tensions: "Tensions",
};

const FACT_CATEGORY_PRIORITY: Record<string, number> = {
  opinion: 5,
  preference: 4,
  experience: 3,
  personal: 2,
  career: 1,
};

const FACT_CATEGORY_LIMITS: Record<string, number> = {
  opinion: 24,
  preference: 18,
  experience: 16,
  personal: 10,
  career: 10,
};

const REQUIRED_IDENTITY_FACETS: IdentityFacet[] = [
  "values",
  "priorities",
  "beliefs",
  "working_style",
];

const FACET_FILL_ORDER: IdentityFacet[] = [
  "values",
  "priorities",
  "beliefs",
  "working_style",
  "communication_style",
  "preferences",
  "tensions",
];

const IDENTITY_FACET_GUIDANCE: Record<IdentityFacet, string> = {
  values:
    "Enduring principles or qualities the subject tries to protect, honor, or preserve.",
  priorities:
    "What the subject repeatedly puts first in work, life, or attention.",
  beliefs:
    "Convictions, theories, or explanatory views the subject explicitly argues for.",
  preferences:
    "Repeated tastes, likes, dislikes, or favored ways of doing things.",
  working_style:
    "How the subject tends to operate, make decisions, or approach work.",
  communication_style:
    "How the subject tends to explain, argue, frame, or express ideas.",
  tensions:
    "A recurring tradeoff, contradiction, or unresolved pull in the subject's identity.",
};

const IDENTITY_SYNTHESIS_PROMPT = `You are synthesizing durable identity memories for a memory protocol.

You will receive transcript-derived facts about a primary subject.
Your job is to convert those facts into first-class identity observations that help answer broad questions like:
- What matters to this person?
- What does this person believe?
- What kind of work, expression, or relationships do they gravitate toward?
- What tensions or tradeoffs shape their choices?

Output ONLY a JSON array. Each item must match this shape:
{"facet":"values|priorities|beliefs|preferences|working_style|communication_style|tensions","text":"<one sentence>","evidence":["<short supporting fact>", "<short supporting fact>"],"confidence":0.0}

Rules:
- Return at most one item per facet.
- Return between 4 and 7 items when the evidence supports it.
- Prefer to include values, priorities, beliefs, and working_style before optional facets.
- Every text sentence must explicitly name the primary subject.
- Treat every output as an inference from public podcast material, not private truth.
- Prefer wording like "In the public podcast corpus, John appears to..."
- Prefer durable patterns over one-off anecdotes.
- Ground every item in the provided facts and patterns. Do not invent.
- Use direct wording that will be useful for later retrieval.
- Favor verbs like values, prioritizes, believes, prefers, tends to, communicates, or is torn between.
- Keep evidence snippets short.
- Omit a facet entirely if the evidence is weak.`;

const SINGLE_FACET_IDENTITY_PROMPT = `You are filling one missing identity facet for a memory protocol.

Return ONLY a JSON object using this shape:
{"facet":"values|priorities|beliefs|preferences|working_style|communication_style|tensions","text":"<one sentence>","evidence":["<short supporting fact>"],"confidence":0.0}

Rules:
- The "facet" field must exactly match the requested facet.
- The text must be one sentence and explicitly name the primary subject.
- Treat the answer as an inference from public podcast material, not private truth.
- Prefer wording like "In the public podcast corpus, John appears to..."
- Ground the answer in the provided facts and patterns only.
- Prefer durable signal over one-off anecdotes.
- Keep evidence snippets short.
- If the evidence is too weak, return the requested facet with an empty text field and an empty evidence array.`;

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function extractPrimarySubjectName(seed: string): string | null {
  const match = seed.match(/\*\*Name:\*\*\s*(.+)/i);
  return match ? match[1].trim() : null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeNameTokens(name: string): string[] {
  return Array.from(
    new Set(
      normalizeText(name)
        .split(/\s+/)
        .filter((token) => token.length >= 3)
    )
  );
}

function isIdentityFacet(value: string): value is IdentityFacet {
  return (IDENTITY_FACETS as readonly string[]).includes(value);
}

function clampObservationQuality(confidence?: number): number {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return 0.9;
  }

  return Math.min(0.96, Math.max(0.82, confidence));
}

function getInferenceConfidenceBand(confidence?: number): "low" | "medium" | "high" {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return "medium";
  }

  if (confidence >= 0.93) {
    return "high";
  }

  if (confidence >= 0.87) {
    return "medium";
  }

  return "low";
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
}

function parseIdentityResponse(response: string): IdentityObservationResponseItem[] {
  try {
    const cleaned = stripCodeFence(response);
    const parsed = JSON.parse(cleaned);

    if (Array.isArray(parsed)) {
      return parsed as IdentityObservationResponseItem[];
    }

    return parsed && typeof parsed === "object"
      ? [parsed as IdentityObservationResponseItem]
      : [];
  } catch {
    console.warn(
      `[podcast-observer] Failed to parse identity synthesis response: ${response.slice(0, 200)}`
    );
    return [];
  }
}

function isIdentityObservationCandidate(
  value: IdentityObservationResponseItem
): value is IdentityObservationCandidate {
  return (
    typeof value.facet === "string" &&
    isIdentityFacet(value.facet) &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    Array.isArray(value.evidence) &&
    value.evidence.every((item) => typeof item === "string") &&
    (typeof value.confidence === "undefined" || typeof value.confidence === "number")
  );
}

function getFactCategory(record: StructuredMemoryRecord): string {
  return typeof record.provenance.category === "string"
    ? record.provenance.category.toLowerCase()
    : "fact";
}

function recordMentionsSubject(
  record: StructuredMemoryRecord,
  subjectTokens: string[]
): boolean {
  const entities = Array.isArray(record.provenance.entities)
    ? record.provenance.entities
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeText(value))
    : [];

  if (
    entities.some((entity) =>
      subjectTokens.some((token) => entity.includes(token))
    )
  ) {
    return true;
  }

  const normalizedText = normalizeText(record.text);
  return subjectTokens.some((token) => normalizedText.includes(token));
}

function selectIdentityFacts(
  facts: StructuredMemoryRecord[],
  subjectName: string
): StructuredMemoryRecord[] {
  const subjectTokens = normalizeNameTokens(subjectName);
  const preferredFacts = facts.filter((record) =>
    recordMentionsSubject(record, subjectTokens)
  );
  const source = preferredFacts.length > 0 ? preferredFacts : facts;
  const deduped = new Map<string, StructuredMemoryRecord>();

  for (const record of source) {
    const normalized = normalizeText(record.text);
    if (normalized.length < 24 || deduped.has(normalized)) {
      continue;
    }
    deduped.set(normalized, record);
  }

  const counts = new Map<string, number>();

  return Array.from(deduped.values())
    .sort((a, b) => {
      const priorityDelta =
        (FACT_CATEGORY_PRIORITY[getFactCategory(b)] ?? 0) -
        (FACT_CATEGORY_PRIORITY[getFactCategory(a)] ?? 0);

      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      if (b.qualityScore !== a.qualityScore) {
        return b.qualityScore - a.qualityScore;
      }

      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .filter((record) => {
      const category = getFactCategory(record);
      const limit = FACT_CATEGORY_LIMITS[category] ?? 8;
      const current = counts.get(category) ?? 0;

      if (current >= limit) {
        return false;
      }

      counts.set(category, current + 1);
      return true;
    })
    .slice(0, 72);
}

function buildFactDossier(records: StructuredMemoryRecord[]): string {
  return records
    .map((record) => {
      const category = getFactCategory(record);
      const episode = record.sourceEpisode ?? "unknown-source";
      return `- [${category} | ${episode}] ${record.text}`;
    })
    .join("\n");
}

function normalizeIdentityObservation(
  item: IdentityObservationResponseItem,
  subjectName: string,
  subjectTokens: string[]
): IdentityObservationCandidate | null {
  if (!isIdentityObservationCandidate(item)) {
    return null;
  }

  const normalizedText = normalizeText(item.text);
  const mentionsSubject = subjectTokens.some((token) =>
    normalizedText.includes(token)
  );

  if (!mentionsSubject) {
    return null;
  }

  const rawText = item.text.trim().replace(/^Public-corpus inference:\s*/i, "");
  const text = /^in the public podcast corpus|^publicly/i.test(rawText)
    ? `Public-corpus inference: ${rawText}`
    : `Public-corpus inference: In the public podcast corpus, ${subjectName} appears to ${rawText.charAt(0).toLowerCase()}${rawText.slice(1)}`;

  return {
    facet: item.facet,
    text,
    evidence: item.evidence
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 3),
    confidence: item.confidence,
  };
}

async function synthesizeIdentityFacet(params: {
  facet: IdentityFacet;
  subjectName: string;
  subjectTokens: string[];
  seed: string;
  patterns: string;
  factDossier: string;
}): Promise<IdentityObservationCandidate | null> {
  const response = await chatCompletion({
    system: SINGLE_FACET_IDENTITY_PROMPT,
    messages: [
      {
        role: "user",
        content: `Primary subject: ${params.subjectName}

Target facet: ${params.facet}
Facet guidance: ${IDENTITY_FACET_GUIDANCE[params.facet]}

Baseline seed:
${params.seed}

Observed podcast patterns:
${params.patterns}

Transcript-derived facts:
${params.factDossier}`,
      },
    ],
    maxTokens: 700,
    timeoutMs: 180_000,
  });

  for (const item of parseIdentityResponse(response)) {
    const normalized = normalizeIdentityObservation(item, params.subjectName, params.subjectTokens);
    if (normalized && normalized.facet === params.facet) {
      return normalized;
    }
  }

  return null;
}

async function synthesizeIdentityObservations(params: {
  seed: string;
  patterns: string;
}): Promise<number> {
  const subjectName = extractPrimarySubjectName(params.seed);
  if (!subjectName) {
    console.warn("[podcast-observer] No subject name found in seed; skipping identity synthesis.");
    return 0;
  }

  const factRows = await getCurrentMemories({
    types: ["fact"],
    limit: 5000,
  });

  if (factRows.length === 0) {
    console.warn("[podcast-observer] No structured facts found; skipping identity synthesis.");
    return 0;
  }

  const selectedFacts = selectIdentityFacts(factRows, subjectName);
  if (selectedFacts.length === 0) {
    console.warn("[podcast-observer] No usable facts selected for identity synthesis.");
    return 0;
  }

  console.log("  [4/4] Writing identity observations...");

  const factDossier = buildFactDossier(selectedFacts);
  const response = await chatCompletion({
    system: IDENTITY_SYNTHESIS_PROMPT,
    messages: [
      {
        role: "user",
        content: `Primary subject: ${subjectName}

Baseline seed:
${params.seed}

Observed podcast patterns:
${params.patterns}

Transcript-derived facts:
${factDossier}`,
      },
    ],
    maxTokens: 2200,
    timeoutMs: 180_000,
  });

  const subjectTokens = normalizeNameTokens(subjectName);
  const byFacet = new Map<IdentityFacet, IdentityObservationCandidate>();

  for (const item of parseIdentityResponse(response)) {
    const normalized = normalizeIdentityObservation(item, subjectName, subjectTokens);
    if (!normalized || byFacet.has(normalized.facet)) {
      continue;
    }

    byFacet.set(normalized.facet, normalized);
  }

  const attemptedFacets = new Set<IdentityFacet>();

  for (const facet of REQUIRED_IDENTITY_FACETS) {
    if (byFacet.has(facet)) {
      continue;
    }

    attemptedFacets.add(facet);
    console.log(`    Backfilling ${facet} facet...`);
    const candidate = await synthesizeIdentityFacet({
      facet,
      subjectName,
      subjectTokens,
      seed: params.seed,
      patterns: params.patterns,
      factDossier,
    });

    if (candidate) {
      byFacet.set(facet, candidate);
    }
  }

  for (const facet of FACET_FILL_ORDER) {
    if (byFacet.size >= 5) {
      break;
    }

    if (byFacet.has(facet) || attemptedFacets.has(facet)) {
      continue;
    }

    console.log(`    Expanding with ${facet} facet...`);
    const candidate = await synthesizeIdentityFacet({
      facet,
      subjectName,
      subjectTokens,
      seed: params.seed,
      patterns: params.patterns,
      factDossier,
    });

    if (candidate) {
      byFacet.set(facet, candidate);
    }
  }

  const observations = IDENTITY_FACETS.map((facet) => byFacet.get(facet)).filter(
    (item): item is IdentityObservationCandidate => Boolean(item)
  );

  if (observations.length === 0) {
    console.warn("[podcast-observer] Identity synthesis returned no valid observations.");
    return 0;
  }

  await fs.mkdir(OBSERVATIONS_DIR, { recursive: true });

  const now = new Date().toISOString();
  const markdownLines: string[] = [
    "# Podcast Identity",
    "",
    `**Generated:** ${now}`,
    `**Primary Subject:** ${subjectName}`,
    `**Observations Written:** ${observations.length}`,
    `**Facts Considered:** ${selectedFacts.length}`,
    `**Facet Coverage:** ${observations.map((observation) => observation.facet).join(", ")}`,
    "",
  ];

  for (const observation of observations) {
    markdownLines.push(`## ${IDENTITY_FACET_LABELS[observation.facet]}`);
    markdownLines.push("");
    markdownLines.push(observation.text);
    markdownLines.push("");

    if (observation.evidence.length > 0) {
      markdownLines.push("Evidence:");
      markdownLines.push(
        ...observation.evidence.map((entry) => `- ${entry}`)
      );
      markdownLines.push("");
    }
  }

  const existingIdentityObservations = (
    await getCurrentMemories({
      types: ["observation"],
      sourceEpisode: PODCAST_IDENTITY_SOURCE_ID,
      limit: IDENTITY_FACETS.length * 4,
    })
  ).filter((record) => record.sourcePath === PODCAST_IDENTITY_SOURCE_PATH);

  const activeSourceIds = new Set(
    observations.map(
      (observation) => `${PODCAST_IDENTITY_SOURCE_ID}:${observation.facet}`
    )
  );

  const staleObservations = existingIdentityObservations.filter(
    (record) => !record.sourceId || !activeSourceIds.has(record.sourceId)
  );

  await fs.writeFile(
    path.join(OBSERVATIONS_DIR, "podcast-identity.md"),
    markdownLines.join("\n"),
    "utf-8"
  );

  if (existingIdentityObservations.length > 0) {
    await deletePointsByFilter({
      type: "observation",
      sourceEpisode: PODCAST_IDENTITY_SOURCE_ID,
    });
  }

  await embedBatch(
    observations.map((observation) => ({
      text: observation.text,
      metadata: {
        type: "observation" as const,
        timestamp: now,
        sessionId: PODCAST_IDENTITY_SOURCE_ID,
        sourcePath: PODCAST_IDENTITY_SOURCE_PATH,
        sourceType: "observer_synthesis" as const,
        sourceId: `${PODCAST_IDENTITY_SOURCE_ID}:${observation.facet}`,
        sourceEpisode: PODCAST_IDENTITY_SOURCE_ID,
        qualityScore: clampObservationQuality(observation.confidence),
        provenance: {
          writer: "podcast-observer.synthesizeIdentityObservations",
          observationKind: "identity",
          knowledgeScope: "public_corpus",
          epistemicStatus: "public_corpus_inference",
          confidenceBand: getInferenceConfidenceBand(observation.confidence),
          facet: observation.facet,
          subjectName,
          evidence: observation.evidence,
          basedOnFactCount: selectedFacts.length,
          basedOnPatternSummary: true,
        },
      },
    }))
  );

  await Promise.all(
    observations.map((observation) =>
      recordMemoryWrite({
        eventId: `observation:${PODCAST_IDENTITY_SOURCE_ID}:${observation.facet}:${now}`,
        memoryKey: `observation:${PODCAST_IDENTITY_SOURCE_ID}:${observation.facet}`,
        memoryType: "observation",
        action: "upsert",
        text: observation.text,
        timestamp: now,
        sessionId: PODCAST_IDENTITY_SOURCE_ID,
        sourceType: "observer_synthesis",
        sourcePath: PODCAST_IDENTITY_SOURCE_PATH,
        sourceId: `${PODCAST_IDENTITY_SOURCE_ID}:${observation.facet}`,
        sourceEpisode: PODCAST_IDENTITY_SOURCE_ID,
        qualityScore: clampObservationQuality(observation.confidence),
        provenance: {
          writer: "podcast-observer.synthesizeIdentityObservations",
          observationKind: "identity",
          knowledgeScope: "public_corpus",
          epistemicStatus: "public_corpus_inference",
          confidenceBand: getInferenceConfidenceBand(observation.confidence),
          facet: observation.facet,
          subjectName,
          evidence: observation.evidence,
          basedOnFactCount: selectedFacts.length,
          basedOnPatternSummary: true,
        },
      })
    )
  );

  if (staleObservations.length > 0) {
    console.log(`    Retiring ${staleObservations.length} stale identity facets...`);

    await Promise.all(
      staleObservations.map((record) =>
        recordMemoryWrite({
          eventId: `observation:${record.sourceId ?? record.memoryKey}:retire:${now}`,
          memoryKey: record.memoryKey,
          memoryType: record.memoryType,
          action: "retire",
          text: record.text,
          timestamp: now,
          sessionId: record.sessionId,
          sourceType: record.sourceType,
          sourcePath: record.sourcePath,
          sourceId: record.sourceId,
          sourceEpisode: record.sourceEpisode,
          qualityScore: record.qualityScore,
          provenance: {
            ...record.provenance,
            writer: "podcast-observer.synthesizeIdentityObservations",
            retiredReason: "facet-absent-from-latest-synthesis",
            retiredAt: now,
          },
        })
      )
    );
  }

  return observations.length;
}

/**
 * Run synthesis over all podcast content.
 * 4 LLM calls: pattern detection -> narrative update -> delta update -> identity observations.
 * Mirrors the observer.ts fullSynthesis pattern and adds explicit identity memories
 * for broader recall queries.
 */
export async function synthesizePodcasts(): Promise<{
  patternsWritten: boolean;
  narrativeUpdated: boolean;
  deltaUpdated: boolean;
  identityObservationsWritten: number;
  relationshipObservationsWritten: number;
}> {
  // Gather podcast vectors, structured facts, and existing identity
  const [podcastVectors, factRows, seed, narrative, delta] = await Promise.all([
    getRecentByType("podcast", 100),
    getCurrentMemories({ types: ["fact"], limit: 5000 }),
    readFileOrNull(path.join(IDENTITY_DIR, "seed.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "narrative.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "delta.md")),
  ]);

  if (!seed) {
    throw new Error("No seed.md found. Complete onboarding first.");
  }

  await syncSeedProfileMemories(seed);

  if (podcastVectors.length === 0 && factRows.length === 0) {
    throw new Error("No podcast vectors or structured facts found. Run transcript extraction first.");
  }

  const subjectName = extractPrimarySubjectName(seed) ?? "the primary subject";
  const fallbackFacts = selectIdentityFacts(factRows, subjectName);
  const synthesisSourceCount =
    podcastVectors.length > 0 ? podcastVectors.length : fallbackFacts.length;

  // Use raw podcast vectors when available, otherwise fall back to structured facts.
  const podcastContent = (
    podcastVectors.length > 0
      ? podcastVectors.map((v) => v.text).join("\n---\n")
      : buildFactDossier(fallbackFacts)
  ).slice(0, 30000);

  console.log(
    podcastVectors.length > 0
      ? `Synthesizing ${podcastVectors.length} podcast vectors...`
      : `Synthesizing ${fallbackFacts.length} structured facts...`
  );

  // --- LLM Call 1: Detect patterns across podcast content ---
  console.log("  [1/4] Detecting patterns...");
  const patterns = await chatCompletion({
    system: `You are an observer module analyzing ingested content (podcast transcripts). These are long-form, unfiltered conversations rich with signal.

Analyze the content and detect:
- Core themes and priorities (what keeps coming up?)
- Communication patterns (how are ideas expressed, argued, explained?)
- Recurring references, examples, or frameworks
- Contradictions or tensions within the content
- Evolution of thinking across different sessions
- Key relationships, influences, or dynamics

Be specific. Cite evidence from the transcripts. Output a structured list of patterns.`,
    messages: [
      {
        role: "user",
        content: `Here is the baseline seed:
${seed}

Here is the available long-form evidence (podcast excerpts or structured facts):
${podcastContent}

What patterns do you observe?`,
      },
    ],
    maxTokens: 3000,
    timeoutMs: 180_000,
  });

  // --- LLM Call 2: Update narrative with podcast insights ---
  console.log("  [2/4] Updating narrative...");
  const newNarrative = await chatCompletion({
    system: `You are updating a living narrative document. You now have access to ingested content (transcripts) that provides deeper signal than the initial seed.

Integrate the new patterns into the existing narrative. The ingested content should deepen the understanding, not replace it. Be direct and specific.

Output ONLY the updated narrative content in markdown. Start with "# Narrative" as the heading.`,
    messages: [
      {
        role: "user",
        content: `Baseline seed:
${seed}

Current narrative:
${narrative || "No narrative yet."}

Patterns detected from ingested content:
${patterns}

Write the updated narrative incorporating these insights.`,
      },
    ],
    maxTokens: 3000,
    timeoutMs: 180_000,
  });

  // --- LLM Call 3: Update delta with podcast insights ---
  console.log("  [3/4] Updating delta...");
  const newDelta = await chatCompletion({
    system: `You are computing the delta - the drift between the stated baseline and what the ingested content reveals. Ingested content is raw and unfiltered, often containing signal that the seed doesn't capture.

Compare the seed with what the ingested patterns reveal. Look for:
- Priorities or themes that appear in the data but not in the seed
- Contradictions between stated intent and observed patterns
- Nuances, complexities, or tensions the seed oversimplifies
- Emergent themes the baseline didn't anticipate

Be specific. If there's no meaningful drift, say so - don't fabricate gaps.

Output ONLY the delta content in markdown. Start with "# Delta" as the heading.`,
    messages: [
      {
        role: "user",
        content: `Baseline seed (stated):
${seed}

Updated narrative:
${newNarrative}

Previous delta:
${delta || "No delta yet."}

Ingested content patterns:
${patterns}

Compute the updated delta.`,
      },
    ],
    maxTokens: 3000,
    timeoutMs: 180_000,
  });

  // Write results
  await fs.mkdir(OBSERVATIONS_DIR, { recursive: true });

  await Promise.all([
    fs.writeFile(path.join(IDENTITY_DIR, "narrative.md"), newNarrative, "utf-8"),
    fs.writeFile(path.join(IDENTITY_DIR, "delta.md"), newDelta, "utf-8"),
    fs.writeFile(
      path.join(OBSERVATIONS_DIR, "podcast-synthesis.md"),
      `# Podcast Synthesis

**Generated:** ${new Date().toISOString()}
**Source records analyzed:** ${synthesisSourceCount}

## Patterns

${patterns}
`,
      "utf-8"
    ),
  ]);

  // Embed the synthesis observation
  const now = new Date().toISOString();
  await embed(patterns, {
    type: "observation",
    timestamp: now,
    sessionId: "podcast-synthesis",
    sourcePath: "memory/observations/podcast-synthesis.md",
    sourceType: "observer_synthesis",
    sourceId: "podcast-synthesis",
    sourceEpisode: "podcast-synthesis",
    qualityScore: 0.88,
    provenance: {
      writer: "podcast-observer.synthesizePodcasts",
      observationKind: "podcast_summary",
      knowledgeScope: "public_corpus",
      epistemicStatus: "public_corpus_inference",
      confidenceBand: "medium",
      basedOnPodcastVectorCount: podcastVectors.length,
      basedOnFactCount: factRows.length,
    },
  });

  await recordMemoryWrite({
    eventId: "observation:podcast-synthesis:capture",
    memoryKey: "observation:podcast-synthesis",
    memoryType: "observation",
    action: "upsert",
    text: patterns,
    timestamp: now,
    sessionId: "podcast-synthesis",
    sourceType: "observer_synthesis",
    sourcePath: "memory/observations/podcast-synthesis.md",
    sourceId: "podcast-synthesis",
    sourceEpisode: "podcast-synthesis",
    qualityScore: 0.88,
    provenance: {
      writer: "podcast-observer.synthesizePodcasts",
      observationKind: "podcast_summary",
      knowledgeScope: "public_corpus",
      epistemicStatus: "public_corpus_inference",
      confidenceBand: "medium",
      basedOnPodcastVectorCount: podcastVectors.length,
      basedOnFactCount: factRows.length,
    },
  });

  const identityObservationsWritten = await synthesizeIdentityObservations({
    seed,
    patterns,
  });

  const relationshipObservationsWritten =
    await synthesizeRelationshipObservations({
      seed,
      patterns,
    });

  console.log("Podcast synthesis complete.");
  return {
    patternsWritten: true,
    narrativeUpdated: true,
    deltaUpdated: true,
    identityObservationsWritten,
    relationshipObservationsWritten,
  };
}




