import fs from "fs/promises";
import path from "path";
import { chatCompletion } from "./llm";
import { deletePointsByFilter, embedBatch } from "./embedder";
import {
  getCurrentMemories,
  recordMemoryWrite,
  type StructuredMemoryRecord,
} from "./memory-store";

const OBSERVATIONS_DIR = path.join(process.cwd(), "memory", "observations");
const PODCAST_RELATIONSHIPS_SOURCE_PATH =
  "memory/observations/podcast-relationships.md";
const PODCAST_RELATIONSHIPS_SOURCE_ID = "podcast-relationships";
const RELATIONSHIP_TARGET_LIMIT = 12;
const RELATIONSHIP_FACT_LIMIT = 12;
const RELATIONSHIP_TOTAL_SCORE_CAP = 24;

const FACT_CATEGORY_PRIORITY: Record<string, number> = {
  opinion: 5,
  preference: 4,
  experience: 3,
  personal: 2,
  career: 1,
};

const NON_PERSON_ENTITIES = new Set([
  "ai",
  "austin",
  "las vegas",
  "los angeles",
  "national geographic",
  "new york",
  "nfts",
  "opensea",
  "phase one",
  "rocks",
  "stonehenge",
  "twitter",
  "x",
]);

interface RelationshipTarget {
  person: string;
  slug: string;
  facts: StructuredMemoryRecord[];
  directFacts: StructuredMemoryRecord[];
  totalCount: number;
  directCount: number;
}

interface RelationshipObservationResponseItem {
  person?: unknown;
  text?: unknown;
  evidence?: unknown;
  confidence?: unknown;
}

interface RelationshipObservationCandidate {
  person: string;
  slug: string;
  text: string;
  evidence: string[];
  confidence?: number;
  totalCount: number;
  directCount: number;
}

const RELATIONSHIP_SYNTHESIS_PROMPT = `You are synthesizing durable relationship memories for a memory protocol.

Return ONLY a JSON object with this shape:
{"person":"<name>","text":"<one sentence>","evidence":["<short supporting fact>"],"confidence":0.0}

Rules:
- The sentence must explicitly name both the primary subject and the target person.
- Focus on the relationship, dynamic, or role the target person plays in the primary subject's world.
- Prefer durable patterns over one-off anecdotes.
- Make the sentence retrieval-friendly for prompts like "What is John's relationship with X?" and "Who are important people in John's world?"
- Do not just summarize the target person's biography.
- Treat every output as an inference from public podcast material, not private truth.
- Prefer wording like "In the public podcast corpus, John's relationship with X appears to..."
- Keep evidence snippets short.
- If the evidence is too weak, return the requested person with an empty text field and an empty evidence array.`;

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

function slugify(value: string): string {
  return normalizeText(value).replace(/\s+/g, "-");
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
}

function clampObservationQuality(confidence?: number): number {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return 0.88;
  }

  return Math.min(0.96, Math.max(0.82, confidence));
}

function getInferenceConfidenceBand(params: {
  directCount: number;
  totalCount: number;
}): "low" | "medium" | "high" {
  if (params.directCount >= 8 || (params.directCount >= 6 && params.totalCount >= 24)) {
    return "high";
  }

  if (params.directCount >= 4 || params.totalCount >= 12) {
    return "medium";
  }

  return "low";
}

function getFactCategory(record: StructuredMemoryRecord): string {
  return typeof record.provenance.category === "string"
    ? record.provenance.category.toLowerCase()
    : "fact";
}

function getRecordEntities(record: StructuredMemoryRecord): string[] {
  return Array.isArray(record.provenance.entities)
    ? Array.from(
        new Set(
          record.provenance.entities
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        )
      )
    : [];
}

function recordMentionsSubject(
  record: StructuredMemoryRecord,
  subjectTokens: string[]
): boolean {
  const entities = getRecordEntities(record).map((value) => normalizeText(value));

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

function looksLikeLikelyPerson(name: string): boolean {
  const normalized = normalizeText(name);
  if (!normalized || NON_PERSON_ENTITIES.has(normalized) || /\d/.test(normalized)) {
    return false;
  }

  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) {
    return false;
  }

  if (parts.length === 1) {
    return /^[A-Z][a-z'.-]{3,}$/.test(parts[0]);
  }

  return parts.every((part) => /^[A-Z][a-z'.-]+$/.test(part));
}

function canonicalizeEntityName(
  entity: string,
  counts: Map<string, number>
): string {
  const trimmed = entity.trim();
  const normalized = normalizeText(trimmed);
  const parts = normalized.split(/\s+/).filter(Boolean);

  if (parts.length !== 1) {
    return trimmed;
  }

  const token = parts[0];
  const candidates = Array.from(counts.entries())
    .filter(([name]) => {
      const candidateParts = normalizeText(name).split(/\s+/).filter(Boolean);
      return candidateParts.length >= 2 && candidateParts.includes(token);
    })
    .sort((a, b) => b[1] - a[1]);

  return candidates[0]?.[0] ?? trimmed;
}

function parseRelationshipResponse(
  response: string
): RelationshipObservationResponseItem | null {
  try {
    const cleaned = stripCodeFence(response);
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RelationshipObservationResponseItem)
      : null;
  } catch {
    console.warn(
      `[relationship-observer] Failed to parse relationship synthesis response: ${response.slice(0, 200)}`
    );
    return null;
  }
}

function ensureRelationshipLead(
  text: string,
  subjectName: string,
  person: string
): string {
  const trimmed = text.trim().replace(/^Public-corpus inference:\s*/i, "");
  const normalizedSubject = subjectName.trim();

  if (/in the public podcast corpus|publicly|relationship with/i.test(trimmed)) {
    return `Public-corpus inference: ${trimmed}`;
  }

  return `Public-corpus inference: ${person} is an important recurring person in ${normalizedSubject}'s public-facing world; in the podcast corpus, ${normalizedSubject}'s relationship with ${person} appears to be shaped by this dynamic: ${trimmed}`;
}

function normalizeRelationshipObservation(params: {
  item: RelationshipObservationResponseItem | null;
  subjectName: string;
  person: string;
  slug: string;
  totalCount: number;
  directCount: number;
}): RelationshipObservationCandidate | null {
  if (!params.item || typeof params.item.text !== "string") {
    return null;
  }

  if (typeof params.item.person !== "string") {
    return null;
  }

  const evidence = Array.isArray(params.item.evidence)
    ? params.item.evidence
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];

  const rawText = params.item.text.trim();
  if (rawText.length < 20) {
    return null;
  }

  const text = ensureRelationshipLead(
    rawText,
    params.subjectName,
    params.person
  );
  const normalizedText = normalizeText(text);
  const subjectTokens = normalizeNameTokens(params.subjectName);
  const personTokens = normalizeNameTokens(params.person);

  const mentionsSubject = subjectTokens.some((token) => normalizedText.includes(token));
  const mentionsPerson = personTokens.some((token) => normalizedText.includes(token));

  if (!mentionsSubject || !mentionsPerson) {
    return null;
  }

  return {
    person: params.person,
    slug: params.slug,
    text,
    evidence,
    confidence:
      typeof params.item.confidence === "number" ? params.item.confidence : undefined,
    totalCount: params.totalCount,
    directCount: params.directCount,
  };
}

function selectRelationshipFacts(target: RelationshipTarget): StructuredMemoryRecord[] {
  const deduped = new Map<string, StructuredMemoryRecord>();
  const source = [...target.directFacts, ...target.facts];

  for (const record of source) {
    const normalized = normalizeText(record.text);
    if (normalized.length < 24 || deduped.has(normalized)) {
      continue;
    }

    deduped.set(normalized, record);
  }

  return Array.from(deduped.values())
    .sort((a, b) => {
      const aDirect = target.directFacts.some((item) => item.memoryKey === a.memoryKey) ? 1 : 0;
      const bDirect = target.directFacts.some((item) => item.memoryKey === b.memoryKey) ? 1 : 0;
      if (bDirect !== aDirect) {
        return bDirect - aDirect;
      }

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
    .slice(0, RELATIONSHIP_FACT_LIMIT);
}

function buildRelationshipDossier(
  target: RelationshipTarget,
  subjectName: string
): string {
  const directKeys = new Set(target.directFacts.map((record) => record.memoryKey));

  return selectRelationshipFacts(target)
    .map((record) => {
      const category = getFactCategory(record);
      const scope = directKeys.has(record.memoryKey)
        ? `${subjectName} + ${target.person}`
        : target.person;
      return `- [${scope} | ${category} | ${record.sourceEpisode ?? "unknown-source"}] ${record.text}`;
    })
    .join("\n");
}

function buildRelationshipTargets(
  facts: StructuredMemoryRecord[],
  subjectName: string
): RelationshipTarget[] {
  const subjectTokens = normalizeNameTokens(subjectName);
  const rawCounts = new Map<string, number>();

  for (const record of facts) {
    for (const entity of getRecordEntities(record)) {
      const normalized = normalizeText(entity);
      if (
        !looksLikeLikelyPerson(entity) ||
        subjectTokens.some((token) => normalized.includes(token))
      ) {
        continue;
      }

      rawCounts.set(entity, (rawCounts.get(entity) ?? 0) + 1);
    }
  }

  const groups = new Map<string, RelationshipTarget>();

  for (const record of facts) {
    const hasSubject = recordMentionsSubject(record, subjectTokens);
    const relatedPeople = Array.from(
      new Set(
        getRecordEntities(record)
          .filter((entity) => looksLikeLikelyPerson(entity))
          .map((entity) => canonicalizeEntityName(entity, rawCounts))
          .filter((entity) => {
            const normalized = normalizeText(entity);
            return !subjectTokens.some((token) => normalized.includes(token));
          })
      )
    );

    for (const person of relatedPeople) {
      const slug = slugify(person);
      const target = groups.get(slug) ?? {
        person,
        slug,
        facts: [],
        directFacts: [],
        totalCount: 0,
        directCount: 0,
      };

      if (!target.facts.some((item) => item.memoryKey === record.memoryKey)) {
        target.facts.push(record);
        target.totalCount += 1;
      }

      if (
        hasSubject &&
        !target.directFacts.some((item) => item.memoryKey === record.memoryKey)
      ) {
        target.directFacts.push(record);
        target.directCount += 1;
      }

      groups.set(slug, target);
    }
  }

  return Array.from(groups.values())
    .filter((target) => target.totalCount >= 3 && target.directCount >= 1)
    .sort((a, b) => {
      const scoreDelta =
        b.directCount * 12 + Math.min(b.totalCount, RELATIONSHIP_TOTAL_SCORE_CAP) -
        (a.directCount * 12 + Math.min(a.totalCount, RELATIONSHIP_TOTAL_SCORE_CAP));
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return a.person.localeCompare(b.person);
    })
    .slice(0, RELATIONSHIP_TARGET_LIMIT);
}

async function synthesizeRelationshipTarget(params: {
  target: RelationshipTarget;
  subjectName: string;
  seed: string;
  patterns: string;
}): Promise<RelationshipObservationCandidate | null> {
  const dossier = buildRelationshipDossier(params.target, params.subjectName);
  if (!dossier) {
    return null;
  }

  const response = await chatCompletion({
    system: RELATIONSHIP_SYNTHESIS_PROMPT,
    messages: [
      {
        role: "user",
        content: `Primary subject: ${params.subjectName}

Target person: ${params.target.person}
Direct shared-fact count: ${params.target.directCount}
Total fact count: ${params.target.totalCount}

Baseline seed:
${params.seed}

Observed podcast patterns:
${params.patterns}

Relationship evidence:
${dossier}`,
      },
    ],
    maxTokens: 900,
    timeoutMs: 180_000,
  });

  return normalizeRelationshipObservation({
    item: parseRelationshipResponse(response),
    subjectName: params.subjectName,
    person: params.target.person,
    slug: params.target.slug,
    totalCount: params.target.totalCount,
    directCount: params.target.directCount,
  });
}

export async function synthesizeRelationshipObservations(params: {
  seed: string;
  patterns: string;
}): Promise<number> {
  const subjectMatch = params.seed.match(/\*\*Name:\*\*\s*(.+)/i);
  const subjectName = subjectMatch?.[1]?.trim();

  if (!subjectName) {
    console.warn("[relationship-observer] No subject name found in seed; skipping relationship synthesis.");
    return 0;
  }

  const factRows = await getCurrentMemories({
    types: ["fact"],
    limit: 5000,
  });

  if (factRows.length === 0) {
    console.warn("[relationship-observer] No structured facts found; skipping relationship synthesis.");
    return 0;
  }

  const targets = buildRelationshipTargets(factRows, subjectName);
  if (targets.length === 0) {
    console.warn("[relationship-observer] No relationship targets found.");
    return 0;
  }

  console.log("  [5/5] Writing relationship observations...");

  const observations: RelationshipObservationCandidate[] = [];
  for (const target of targets) {
    console.log(`    Synthesizing relationship: ${target.person}...`);
    const observation = await synthesizeRelationshipTarget({
      target,
      subjectName,
      seed: params.seed,
      patterns: params.patterns,
    });

    if (observation) {
      observations.push(observation);
    }
  }

  if (observations.length === 0) {
    console.warn("[relationship-observer] Relationship synthesis returned no valid observations.");
    return 0;
  }

  await fs.mkdir(OBSERVATIONS_DIR, { recursive: true });
  const now = new Date().toISOString();
  const markdownLines = [
    "# Podcast Relationships",
    "",
    `**Generated:** ${now}`,
    `**Primary Subject:** ${subjectName}`,
    `**Relationships Written:** ${observations.length}`,
    "",
    ...observations.flatMap((observation) => [
      `## ${observation.person}`,
      "",
      observation.text,
      "",
      `- Direct shared facts: ${observation.directCount}`,
      `- Total facts considered: ${observation.totalCount}`,
      ...(observation.evidence.length > 0
        ? ["", "Evidence:", ...observation.evidence.map((entry) => `- ${entry}`)]
        : []),
      "",
    ]),
  ];

  const existingRelationshipObservations = (
    await getCurrentMemories({
      types: ["observation"],
      sourceEpisode: PODCAST_RELATIONSHIPS_SOURCE_ID,
      limit: RELATIONSHIP_TARGET_LIMIT * 3,
    })
  ).filter((record) => record.sourcePath === PODCAST_RELATIONSHIPS_SOURCE_PATH);

  const activeSourceIds = new Set(
    observations.map((observation) => `${PODCAST_RELATIONSHIPS_SOURCE_ID}:${observation.slug}`)
  );
  const staleObservations = existingRelationshipObservations.filter(
    (record) => !record.sourceId || !activeSourceIds.has(record.sourceId)
  );

  await fs.writeFile(
    path.join(OBSERVATIONS_DIR, "podcast-relationships.md"),
    markdownLines.join("\n"),
    "utf-8"
  );

  if (existingRelationshipObservations.length > 0) {
    await deletePointsByFilter({
      type: "observation",
      sourceEpisode: PODCAST_RELATIONSHIPS_SOURCE_ID,
    });
  }

  await embedBatch(
    observations.map((observation) => ({
      text: observation.text,
      metadata: {
        type: "observation" as const,
        timestamp: now,
        sessionId: PODCAST_RELATIONSHIPS_SOURCE_ID,
        sourcePath: PODCAST_RELATIONSHIPS_SOURCE_PATH,
        sourceType: "observer_synthesis" as const,
        sourceId: `${PODCAST_RELATIONSHIPS_SOURCE_ID}:${observation.slug}`,
        sourceEpisode: PODCAST_RELATIONSHIPS_SOURCE_ID,
        qualityScore: clampObservationQuality(observation.confidence),
        provenance: {
          writer: "relationship-observer.synthesizeRelationshipObservations",
          observationKind: "relationship",
          knowledgeScope: "public_corpus",
          epistemicStatus: "public_corpus_inference",
          confidenceBand: getInferenceConfidenceBand({
            directCount: observation.directCount,
            totalCount: observation.totalCount,
          }),
          relatedPerson: observation.person,
          subjectName,
          evidence: observation.evidence,
          basedOnFactCount: observation.totalCount,
          basedOnDirectFactCount: observation.directCount,
        },
      },
    }))
  );

  await Promise.all(
    observations.map((observation) =>
      recordMemoryWrite({
        eventId: `observation:${PODCAST_RELATIONSHIPS_SOURCE_ID}:${observation.slug}:${now}`,
        memoryKey: `observation:${PODCAST_RELATIONSHIPS_SOURCE_ID}:${observation.slug}`,
        memoryType: "observation",
        action: "upsert",
        text: observation.text,
        timestamp: now,
        sessionId: PODCAST_RELATIONSHIPS_SOURCE_ID,
        sourceType: "observer_synthesis",
        sourcePath: PODCAST_RELATIONSHIPS_SOURCE_PATH,
        sourceId: `${PODCAST_RELATIONSHIPS_SOURCE_ID}:${observation.slug}`,
        sourceEpisode: PODCAST_RELATIONSHIPS_SOURCE_ID,
        qualityScore: clampObservationQuality(observation.confidence),
        provenance: {
          writer: "relationship-observer.synthesizeRelationshipObservations",
          observationKind: "relationship",
          knowledgeScope: "public_corpus",
          epistemicStatus: "public_corpus_inference",
          confidenceBand: getInferenceConfidenceBand({
            directCount: observation.directCount,
            totalCount: observation.totalCount,
          }),
          relatedPerson: observation.person,
          subjectName,
          evidence: observation.evidence,
          basedOnFactCount: observation.totalCount,
          basedOnDirectFactCount: observation.directCount,
        },
      })
    )
  );

  if (staleObservations.length > 0) {
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
            writer: "relationship-observer.synthesizeRelationshipObservations",
            retiredReason: "relationship-absent-from-latest-synthesis",
            retiredAt: now,
          },
        })
      )
    );
  }

  return observations.length;
}
