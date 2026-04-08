/**
 * Nightly Maintenance — Memory hygiene pipeline.
 *
 * Steps 1-4: No LLM calls (dedup, quality sweep, stale detection)
 * Steps 5-7: Batched LLM calls (contradiction/entity/belief refresh)
 */

import { DatabaseSync } from "node:sqlite";
import {
  initStructuredMemory,
  getCurrentMemories,
  recordMemoryWrite,
  STRUCTURED_MEMORY_DB_PATH,
} from "./memory-store";
import {
  ensureWorldModelSchema,
  extractWorldData,
  upsertEntity,
  recordEntityMention,
  recordBelief,
  recordOpenLoop,
  recordContradiction,
  findEntityByName,
  listOpenLoops,
  reviseBelief,
  listBeliefs,
} from "./world-model";
import { search } from "./retriever";
import { randomUUID } from "node:crypto";

export interface MaintenanceReport {
  exactDedups: number;
  semanticDedups: number;
  semanticDedupProcessed: number;
  qualityRetired: number;
  staleLoops: number;
  contradictionsRefreshed: number;
  entitiesRefreshed: number;
  beliefsRefreshed: number;
  dryRun: boolean;
  duration: number;
}

export interface MaintenanceOptions {
  dryRun?: boolean;
  maxSemanticDedup?: number;
  steps?: (
    | "dedup"
    | "semantic-dedup"
    | "quality"
    | "stale-loops"
    | "contradictions"
    | "entities"
    | "beliefs"
  )[];
}

function getDb(): DatabaseSync {
  return new DatabaseSync(STRUCTURED_MEMORY_DB_PATH);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

// ── Step 1: Exact dedup ──────────────────────────────────────────────────────

async function exactDedup(dryRun: boolean): Promise<number> {
  const memories = await getCurrentMemories({ limit: 1000 });

  const byNormalized = new Map<
    string,
    (typeof memories)[0][]
  >();

  for (const mem of memories) {
    const key = normalizeText(mem.text);
    const group = byNormalized.get(key) || [];
    group.push(mem);
    byNormalized.set(key, group);
  }

  let retired = 0;
  for (const [, group] of byNormalized) {
    if (group.length <= 1) continue;

    // Keep the highest quality, most recent one
    group.sort((a, b) => {
      if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    const keep = group[0];
    for (let i = 1; i < group.length; i++) {
      const dupe = group[i];
      if (!dryRun) {
        await recordMemoryWrite({
          eventId: `maintenance:dedup:${randomUUID().slice(0, 8)}`,
          memoryKey: dupe.memoryKey,
          memoryType: dupe.memoryType,
          action: "retire",
          text: dupe.text,
          timestamp: new Date().toISOString(),
          sourceType: dupe.sourceType,
          qualityScore: dupe.qualityScore,
          provenance: {
            retiredBy: "maintenance.exact-dedup",
            keptKey: keep.memoryKey,
          },
        });
      }
      retired++;
    }
  }

  return retired;
}

// ── Step 2: Semantic dedup ───────────────────────────────────────────────────

async function semanticDedup(
  dryRun: boolean,
  maxMemories?: number
): Promise<{ merged: number; processed: number }> {
  const memories = await getCurrentMemories({ limit: 500 });
  let merged = 0;

  const toProcess = maxMemories ? memories.slice(0, maxMemories) : memories;
  const BATCH_SIZE = 50;
  const processed = new Set<string>();

  for (let batchStart = 0; batchStart < toProcess.length; batchStart += BATCH_SIZE) {
    const batch = toProcess.slice(batchStart, batchStart + BATCH_SIZE);

    for (const mem of batch) {
      if (processed.has(mem.memoryKey)) continue;

      try {
        const similar = await search(mem.text, {
          limit: 5,
          scoreThreshold: 0.95,
        });

        for (const result of similar) {
          const resultKey =
            result.metadata.sourceId || result.metadata.sessionId || result.id;
          if (!resultKey || resultKey === mem.memoryKey) continue;
          if (processed.has(resultKey)) continue;

          // Found a near-duplicate — retire the lower quality one
          const matchingMem = memories.find(
            (m) =>
              m.memoryKey === resultKey ||
              m.sourceId === resultKey ||
              m.sessionId === resultKey
          );

          if (matchingMem && matchingMem.memoryKey !== mem.memoryKey) {
            const [keep, retire] =
              mem.qualityScore >= matchingMem.qualityScore
                ? [mem, matchingMem]
                : [matchingMem, mem];

            if (!dryRun) {
              await recordMemoryWrite({
                eventId: `maintenance:semantic-dedup:${randomUUID().slice(0, 8)}`,
                memoryKey: retire.memoryKey,
                memoryType: retire.memoryType,
                action: "retire",
                text: retire.text,
                timestamp: new Date().toISOString(),
                sourceType: retire.sourceType,
                qualityScore: retire.qualityScore,
                provenance: {
                  retiredBy: "maintenance.semantic-dedup",
                  keptKey: keep.memoryKey,
                  similarity: result.score,
                },
              });
            }
            processed.add(retire.memoryKey);
            merged++;
          }
        }
      } catch {
        // Qdrant may not be running — skip semantic dedup
      }

      processed.add(mem.memoryKey);
    }
  }

  return { merged, processed: processed.size };
}

// ── Step 3: Quality sweep ────────────────────────────────────────────────────

async function qualitySweep(dryRun: boolean): Promise<number> {
  const memories = await getCurrentMemories({ limit: 1000 });
  const lowQuality = memories.filter((m) => m.qualityScore < 0.4);
  let retired = 0;

  for (const mem of lowQuality) {
    if (!dryRun) {
      await recordMemoryWrite({
        eventId: `maintenance:quality:${randomUUID().slice(0, 8)}`,
        memoryKey: mem.memoryKey,
        memoryType: mem.memoryType,
        action: "retire",
        text: mem.text,
        timestamp: new Date().toISOString(),
        sourceType: mem.sourceType,
        qualityScore: mem.qualityScore,
        provenance: {
          retiredBy: "maintenance.quality-sweep",
          originalQuality: mem.qualityScore,
        },
      });
    }
    retired++;
  }

  return retired;
}

// ── Step 4: Stale open loop detection ────────────────────────────────────────

function markStaleLoops(dryRun: boolean): number {
  const loops = listOpenLoops("open");
  const now = Date.now();
  const STALE_THRESHOLD_DAYS = 30;
  let stale = 0;

  const db = getDb();
  for (const loop of loops) {
    const ageDays = (now - new Date(loop.detectedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > STALE_THRESHOLD_DAYS) {
      if (!dryRun) {
        db.prepare(
          `UPDATE world_open_loops SET status = 'stale' WHERE loop_id = ?`
        ).run(loop.loopId);
      }
      stale++;
    }
  }

  return stale;
}

// ── Step 5: Contradiction refresh ────────────────────────────────────────────

async function contradictionRefresh(dryRun: boolean): Promise<number> {
  if (dryRun) return 0;

  const recentMemories = await getCurrentMemories({
    types: ["conversation"],
    limit: 20,
  });

  if (recentMemories.length === 0) return 0;

  const textBlock = recentMemories
    .slice(0, 10)
    .map((m) => m.text)
    .join("\n---\n");

  const extracted = await extractWorldData(textBlock);
  const now = new Date().toISOString();
  let count = 0;

  for (const c of extracted.contradictions) {
    if (!c.statementA || !c.statementB) continue;
    const entityId = c.aboutEntity
      ? findEntityByName(c.aboutEntity)?.entityId ?? null
      : null;
    recordContradiction(
      c.statementA,
      c.statementB,
      recentMemories[0]?.memoryKey ?? "unknown",
      recentMemories[recentMemories.length - 1]?.memoryKey ?? "unknown",
      entityId,
      now
    );
    count++;
  }

  return count;
}

// ── Step 6: Entity refresh ───────────────────────────────────────────────────

async function entityRefresh(dryRun: boolean): Promise<number> {
  if (dryRun) return 0;

  const recentMemories = await getCurrentMemories({
    types: ["conversation", "observation"],
    limit: 30,
  });

  if (recentMemories.length === 0) return 0;

  const textBlock = recentMemories
    .slice(0, 15)
    .map((m) => m.text)
    .join("\n---\n");

  const extracted = await extractWorldData(textBlock);
  const now = new Date().toISOString();
  let count = 0;

  for (const e of extracted.entities) {
    if (!e.name || !e.kind) continue;
    const entity = upsertEntity(e.name, e.kind, now);
    for (const m of recentMemories) {
      if (m.text.toLowerCase().includes(e.name.toLowerCase())) {
        recordEntityMention(entity.entityId, m.memoryKey, now);
      }
    }
    count++;
  }

  return count;
}

// ── Step 7: Belief refresh ───────────────────────────────────────────────────

async function beliefRefresh(dryRun: boolean): Promise<number> {
  if (dryRun) return 0;

  const recentMemories = await getCurrentMemories({
    types: ["conversation"],
    limit: 20,
  });

  if (recentMemories.length === 0) return 0;

  const textBlock = recentMemories
    .slice(0, 10)
    .map((m) => m.text)
    .join("\n---\n");

  const extracted = await extractWorldData(textBlock);
  const now = new Date().toISOString();
  let count = 0;

  const existingBeliefs = listBeliefs("active");

  for (const b of extracted.beliefs) {
    if (!b.content) continue;
    const entityId = b.aboutEntity
      ? findEntityByName(b.aboutEntity)?.entityId ?? null
      : null;

    // Check if this revises an existing belief
    const overlapping = existingBeliefs.find(
      (existing) =>
        existing.entityId === entityId &&
        existing.content.length > 0 &&
        b.content.length > 0 &&
        normalizeText(existing.content).includes(normalizeText(b.content).slice(0, 40))
    );
    if (overlapping) {
      reviseBelief(overlapping.beliefId, b.content, recentMemories[0]?.memoryKey ?? "unknown", now);
    } else {
      recordBelief(b.content, entityId, recentMemories[0]?.memoryKey ?? "unknown", now);
    }
    count++;
  }

  return count;
}

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function runMaintenance(
  options: MaintenanceOptions = {}
): Promise<MaintenanceReport> {
  const { dryRun = false, steps } = options;
  const startTime = Date.now();

  await initStructuredMemory();
  ensureWorldModelSchema();

  const runAll = !steps || steps.length === 0;
  const runStep = (s: string) => runAll || steps!.includes(s as any);

  // Steps 1-4: No LLM calls
  const exactDedups = runStep("dedup") ? await exactDedup(dryRun) : 0;
  const { merged: semanticDedups, processed: semanticDedupProcessed } = runStep("semantic-dedup")
    ? await semanticDedup(dryRun, options.maxSemanticDedup)
    : { merged: 0, processed: 0 };
  const qualityRetired = runStep("quality") ? await qualitySweep(dryRun) : 0;
  const staleLoops = runStep("stale-loops") ? markStaleLoops(dryRun) : 0;

  // Steps 5-7: Batched LLM calls
  const [contradictionsRefreshed, entitiesRefreshed, beliefsRefreshed] =
    await Promise.all([
      runStep("contradictions") ? contradictionRefresh(dryRun) : 0,
      runStep("entities") ? entityRefresh(dryRun) : 0,
      runStep("beliefs") ? beliefRefresh(dryRun) : 0,
    ]);

  return {
    exactDedups,
    semanticDedups,
    semanticDedupProcessed,
    qualityRetired,
    staleLoops,
    contradictionsRefreshed,
    entitiesRefreshed,
    beliefsRefreshed,
    dryRun,
    duration: Date.now() - startTime,
  };
}
