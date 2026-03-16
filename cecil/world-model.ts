/**
 * World Model — Entities, beliefs, open loops, and contradictions.
 *
 * Builds a structured model of the user's world from accumulated memories.
 * Inspired by Gigabrain's world-model.js, adapted for Cecil's SQLite + Qdrant stack.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chatCompletion } from "./llm";
import {
  initStructuredMemory,
  getCurrentMemories,
  STRUCTURED_MEMORY_DB_PATH,
} from "./memory-store";

// ── Types ────────────────────────────────────────────────────────────────────

export type EntityKind =
  | "person"
  | "project"
  | "organization"
  | "place"
  | "topic";

export type BeliefStatus = "active" | "revised" | "contradicted";

export type OpenLoopStatus = "open" | "resolved" | "stale";

export interface WorldEntity {
  entityId: string;
  name: string;
  kind: EntityKind;
  summary: string;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
}

export interface WorldBelief {
  beliefId: string;
  entityId: string | null; // null = general belief
  content: string;
  status: BeliefStatus;
  firstStated: string;
  lastStated: string;
  sourceMemoryKeys: string; // JSON array of memory keys
}

export interface WorldOpenLoop {
  loopId: string;
  entityId: string | null;
  content: string;
  status: OpenLoopStatus;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface WorldContradiction {
  contradictionId: string;
  entityId: string | null;
  statementA: string;
  statementB: string;
  memoryKeyA: string;
  memoryKeyB: string;
  detectedAt: string;
  resolved: boolean;
}

export interface WorldEntityMention {
  mentionId: string;
  entityId: string;
  memoryKey: string;
  createdAt: string;
}

export interface WorldModelSummary {
  entities: number;
  beliefs: number;
  openLoops: number;
  contradictions: number;
}

// ── Regex patterns for entity extraction ─────────────────────────────────────

const PERSON_RE =
  /\b(?:partner|wife|husband|friend|girlfriend|boyfriend|colleague|mentor|client|boss|manager)\b/i;
const PROJECT_RE =
  /\b(?:project|repo|product|feature|launch|app|platform|tool|service|startup|venture|business)\b/i;
const ORG_RE =
  /\b(?:company|startup|firm|organization|agency|studio|team|group|brand)\b/i;
const PLACE_RE =
  /\b(?:city|country|town|office|home|studio|neighborhood|district|area)\b/i;
const OPEN_LOOP_RE =
  /\b(?:follow[\s-]?up|todo|pending|need to|should|plan to|going to|want to|haven't|haven't yet|still need|next step)\b|\?$/i;
const BELIEF_RE =
  /\b(?:believe|think|feel|opinion|conviction|philosophy|principle|approach|always|never|important|matters|value|prefer)\b/i;
const CONTRADICTION_MARKERS =
  /\b(?:actually|wait|no|correction|changed my mind|used to|not anymore|different now|I was wrong)\b/i;

// ── Database setup ───────────────────────────────────────────────────────────

let worldDb: DatabaseSync | null = null;

function getWorldDb(): DatabaseSync {
  if (!worldDb) {
    worldDb = new DatabaseSync(STRUCTURED_MEMORY_DB_PATH);
  }
  return worldDb;
}

export function ensureWorldModelSchema(): void {
  const db = getWorldDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS world_entities (
      entity_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS world_entity_mentions (
      mention_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(entity_id, memory_key)
    );

    CREATE TABLE IF NOT EXISTS world_beliefs (
      belief_id TEXT PRIMARY KEY,
      entity_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      first_stated TEXT NOT NULL,
      last_stated TEXT NOT NULL,
      source_memory_keys TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS world_open_loops (
      loop_id TEXT PRIMARY KEY,
      entity_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      detected_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS world_contradictions (
      contradiction_id TEXT PRIMARY KEY,
      entity_id TEXT,
      statement_a TEXT NOT NULL,
      statement_b TEXT NOT NULL,
      memory_key_a TEXT NOT NULL,
      memory_key_b TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_world_entities_kind
      ON world_entities (kind);
    CREATE INDEX IF NOT EXISTS idx_world_entity_mentions_entity
      ON world_entity_mentions (entity_id);
    CREATE INDEX IF NOT EXISTS idx_world_entity_mentions_memory
      ON world_entity_mentions (memory_key);
    CREATE INDEX IF NOT EXISTS idx_world_beliefs_status
      ON world_beliefs (status);
    CREATE INDEX IF NOT EXISTS idx_world_open_loops_status
      ON world_open_loops (status);
    CREATE INDEX IF NOT EXISTS idx_world_contradictions_resolved
      ON world_contradictions (resolved);
  `);
}

// ── Entity operations ────────────────────────────────────────────────────────

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findEntityByName(name: string): WorldEntity | null {
  const db = getWorldDb();
  const normalized = normalizeEntityName(name);
  const row = db
    .prepare(
      `SELECT * FROM world_entities WHERE lower(name) = ? LIMIT 1`
    )
    .get<any>(normalized);

  if (!row) return null;
  return {
    entityId: row.entity_id,
    name: row.name,
    kind: row.kind,
    summary: row.summary,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    mentionCount: row.mention_count,
  };
}

export function upsertEntity(
  name: string,
  kind: EntityKind,
  timestamp: string
): WorldEntity {
  const db = getWorldDb();
  const existing = findEntityByName(name);

  if (existing) {
    db.prepare(
      `UPDATE world_entities
       SET last_seen = ?, mention_count = mention_count + 1
       WHERE entity_id = ?`
    ).run(timestamp, existing.entityId);
    return { ...existing, lastSeen: timestamp, mentionCount: existing.mentionCount + 1 };
  }

  const entityId = `entity-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO world_entities (entity_id, name, kind, summary, first_seen, last_seen, mention_count)
     VALUES (?, ?, ?, '', ?, ?, 1)`
  ).run(entityId, name.trim(), kind, timestamp, timestamp);

  return {
    entityId,
    name: name.trim(),
    kind,
    summary: "",
    firstSeen: timestamp,
    lastSeen: timestamp,
    mentionCount: 1,
  };
}

export function recordEntityMention(
  entityId: string,
  memoryKey: string,
  timestamp: string
): void {
  const db = getWorldDb();
  db.prepare(
    `INSERT OR IGNORE INTO world_entity_mentions (mention_id, entity_id, memory_key, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(`mention-${randomUUID().slice(0, 8)}`, entityId, memoryKey, timestamp);
}

export function listEntities(kind?: EntityKind): WorldEntity[] {
  const db = getWorldDb();
  const query = kind
    ? `SELECT * FROM world_entities WHERE kind = ? ORDER BY mention_count DESC, last_seen DESC`
    : `SELECT * FROM world_entities ORDER BY mention_count DESC, last_seen DESC`;

  const rows = kind
    ? db.prepare(query).all<any>(kind)
    : db.prepare(query).all<any>();

  return rows.map((row) => ({
    entityId: row.entity_id,
    name: row.name,
    kind: row.kind,
    summary: row.summary,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    mentionCount: row.mention_count,
  }));
}

// ── Belief operations ────────────────────────────────────────────────────────

export function recordBelief(
  content: string,
  entityId: string | null,
  memoryKey: string,
  timestamp: string
): WorldBelief {
  const db = getWorldDb();
  const beliefId = `belief-${randomUUID().slice(0, 8)}`;
  const sourceKeys = JSON.stringify([memoryKey]);

  db.prepare(
    `INSERT INTO world_beliefs (belief_id, entity_id, content, status, first_stated, last_stated, source_memory_keys)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`
  ).run(beliefId, entityId, content.trim(), timestamp, timestamp, sourceKeys);

  return {
    beliefId,
    entityId,
    content: content.trim(),
    status: "active",
    firstStated: timestamp,
    lastStated: timestamp,
    sourceMemoryKeys: sourceKeys,
  };
}

export function listBeliefs(status?: BeliefStatus): WorldBelief[] {
  const db = getWorldDb();
  const query = status
    ? `SELECT * FROM world_beliefs WHERE status = ? ORDER BY last_stated DESC`
    : `SELECT * FROM world_beliefs ORDER BY last_stated DESC`;

  const rows = status
    ? db.prepare(query).all<any>(status)
    : db.prepare(query).all<any>();

  return rows.map((row) => ({
    beliefId: row.belief_id,
    entityId: row.entity_id,
    content: row.content,
    status: row.status,
    firstStated: row.first_stated,
    lastStated: row.last_stated,
    sourceMemoryKeys: row.source_memory_keys,
  }));
}

// ── Open loop operations ─────────────────────────────────────────────────────

export function recordOpenLoop(
  content: string,
  entityId: string | null,
  timestamp: string
): WorldOpenLoop {
  const db = getWorldDb();
  const loopId = `loop-${randomUUID().slice(0, 8)}`;

  db.prepare(
    `INSERT INTO world_open_loops (loop_id, entity_id, content, status, detected_at)
     VALUES (?, ?, ?, 'open', ?)`
  ).run(loopId, entityId, content.trim(), timestamp);

  return {
    loopId,
    entityId,
    content: content.trim(),
    status: "open",
    detectedAt: timestamp,
    resolvedAt: null,
  };
}

export function resolveOpenLoop(loopId: string): void {
  const db = getWorldDb();
  db.prepare(
    `UPDATE world_open_loops SET status = 'resolved', resolved_at = ? WHERE loop_id = ?`
  ).run(new Date().toISOString(), loopId);
}

export function listOpenLoops(status?: OpenLoopStatus): WorldOpenLoop[] {
  const db = getWorldDb();
  const query = status
    ? `SELECT * FROM world_open_loops WHERE status = ? ORDER BY detected_at DESC`
    : `SELECT * FROM world_open_loops ORDER BY detected_at DESC`;

  const rows = status
    ? db.prepare(query).all<any>(status)
    : db.prepare(query).all<any>();

  return rows.map((row) => ({
    loopId: row.loop_id,
    entityId: row.entity_id,
    content: row.content,
    status: row.status,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
  }));
}

// ── Contradiction operations ─────────────────────────────────────────────────

export function recordContradiction(
  statementA: string,
  statementB: string,
  memoryKeyA: string,
  memoryKeyB: string,
  entityId: string | null,
  timestamp: string
): WorldContradiction {
  const db = getWorldDb();
  const contradictionId = `contra-${randomUUID().slice(0, 8)}`;

  db.prepare(
    `INSERT INTO world_contradictions
     (contradiction_id, entity_id, statement_a, statement_b, memory_key_a, memory_key_b, detected_at, resolved)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    contradictionId,
    entityId,
    statementA.trim(),
    statementB.trim(),
    memoryKeyA,
    memoryKeyB,
    timestamp
  );

  return {
    contradictionId,
    entityId,
    statementA: statementA.trim(),
    statementB: statementB.trim(),
    memoryKeyA,
    memoryKeyB,
    detectedAt: timestamp,
    resolved: false,
  };
}

export function listContradictions(
  unresolvedOnly = true
): WorldContradiction[] {
  const db = getWorldDb();
  const query = unresolvedOnly
    ? `SELECT * FROM world_contradictions WHERE resolved = 0 ORDER BY detected_at DESC`
    : `SELECT * FROM world_contradictions ORDER BY detected_at DESC`;

  const rows = db.prepare(query).all<any>();

  return rows.map((row) => ({
    contradictionId: row.contradiction_id,
    entityId: row.entity_id,
    statementA: row.statement_a,
    statementB: row.statement_b,
    memoryKeyA: row.memory_key_a,
    memoryKeyB: row.memory_key_b,
    detectedAt: row.detected_at,
    resolved: Boolean(row.resolved),
  }));
}

// ── World model summary ──────────────────────────────────────────────────────

export function getWorldModelSummary(): WorldModelSummary {
  const db = getWorldDb();

  const entities =
    (db.prepare(`SELECT COUNT(*) as c FROM world_entities`).get<any>()?.c as number) ?? 0;
  const beliefs =
    (db
      .prepare(`SELECT COUNT(*) as c FROM world_beliefs WHERE status = 'active'`)
      .get<any>()?.c as number) ?? 0;
  const openLoops =
    (db
      .prepare(`SELECT COUNT(*) as c FROM world_open_loops WHERE status = 'open'`)
      .get<any>()?.c as number) ?? 0;
  const contradictions =
    (db
      .prepare(`SELECT COUNT(*) as c FROM world_contradictions WHERE resolved = 0`)
      .get<any>()?.c as number) ?? 0;

  return { entities, beliefs, openLoops, contradictions };
}

// ── LLM-powered extraction ──────────────────────────────────────────────────

interface ExtractedWorldData {
  entities: { name: string; kind: EntityKind }[];
  beliefs: { content: string; aboutEntity?: string }[];
  openLoops: { content: string; aboutEntity?: string }[];
  contradictions: {
    statementA: string;
    statementB: string;
    aboutEntity?: string;
  }[];
}

const EXTRACTION_PROMPT = `You are a memory analyst. Given a block of conversation or memory text, extract structured data about the user's world.

Return ONLY valid JSON with this exact schema (no markdown, no explanation):
{
  "entities": [{"name": "...", "kind": "person|project|organization|place|topic"}],
  "beliefs": [{"content": "User believes/thinks...", "aboutEntity": "optional entity name"}],
  "openLoops": [{"content": "User said they would...", "aboutEntity": "optional entity name"}],
  "contradictions": [{"statementA": "Earlier they said...", "statementB": "Now they say...", "aboutEntity": "optional entity name"}]
}

Rules:
- entities: Real people, projects, companies, places, or recurring topics the user mentions. Not generic concepts.
- beliefs: Opinions, preferences, principles, values the user has expressed. State them as "User believes/thinks/prefers..."
- openLoops: Things the user said they would do, plan to do, or need to do that appear unresolved. State as "User said they would..."
- contradictions: ONLY if the text contains genuinely conflicting statements. Most text has none.
- If a category has nothing, use an empty array.
- Be conservative. Only extract what is clearly stated, not inferred.`;

export async function extractWorldData(
  text: string
): Promise<ExtractedWorldData> {
  const response = await chatCompletion({
    system: EXTRACTION_PROMPT,
    messages: [{ role: "user", content: text }],
    maxTokens: 2048,
  });

  try {
    // Try to extract JSON from the response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { entities: [], beliefs: [], openLoops: [], contradictions: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      beliefs: Array.isArray(parsed.beliefs) ? parsed.beliefs : [],
      openLoops: Array.isArray(parsed.openLoops) ? parsed.openLoops : [],
      contradictions: Array.isArray(parsed.contradictions)
        ? parsed.contradictions
        : [],
    };
  } catch {
    return { entities: [], beliefs: [], openLoops: [], contradictions: [] };
  }
}

// ── Build / refresh world model from memories ────────────────────────────────

export async function rebuildWorldModel(): Promise<WorldModelSummary> {
  await initStructuredMemory();
  ensureWorldModelSchema();

  // Pull recent memories to extract from
  const memories = await getCurrentMemories({
    types: ["conversation", "fact", "observation", "milestone"],
    limit: 100,
  });

  if (memories.length === 0) {
    return getWorldModelSummary();
  }

  // Build text blocks from memories (batch them to avoid huge LLM calls)
  const BATCH_SIZE = 15;
  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    const textBlock = batch
      .map(
        (m, idx) =>
          `[Memory ${i + idx + 1} | key:${m.memoryKey} | ${m.memoryType}]\n${m.text}`
      )
      .join("\n\n---\n\n");

    const extracted = await extractWorldData(textBlock);
    const now = new Date().toISOString();

    // Process entities
    for (const e of extracted.entities) {
      if (!e.name || !e.kind) continue;
      const entity = upsertEntity(e.name, e.kind, now);
      // Link to all memories in this batch
      for (const m of batch) {
        if (m.text.toLowerCase().includes(e.name.toLowerCase())) {
          recordEntityMention(entity.entityId, m.memoryKey, now);
        }
      }
    }

    // Process beliefs
    for (const b of extracted.beliefs) {
      if (!b.content) continue;
      const entityId = b.aboutEntity
        ? findEntityByName(b.aboutEntity)?.entityId ?? null
        : null;
      const sourceKey = batch[0]?.memoryKey ?? "unknown";
      recordBelief(b.content, entityId, sourceKey, now);
    }

    // Process open loops
    for (const ol of extracted.openLoops) {
      if (!ol.content) continue;
      const entityId = ol.aboutEntity
        ? findEntityByName(ol.aboutEntity)?.entityId ?? null
        : null;
      recordOpenLoop(ol.content, entityId, now);
    }

    // Process contradictions
    for (const c of extracted.contradictions) {
      if (!c.statementA || !c.statementB) continue;
      const entityId = c.aboutEntity
        ? findEntityByName(c.aboutEntity)?.entityId ?? null
        : null;
      recordContradiction(
        c.statementA,
        c.statementB,
        batch[0]?.memoryKey ?? "unknown",
        batch[batch.length - 1]?.memoryKey ?? "unknown",
        entityId,
        now
      );
    }
  }

  return getWorldModelSummary();
}

// ── Query intent classification ──────────────────────────────────────────────

export type QueryStrategy =
  | "entity_brief"
  | "relationship_brief"
  | "timeline_brief"
  | "contradiction_check"
  | "open_loop_check"
  | "belief_check"
  | "quick_context";

const ENTITY_QUERY_RE =
  /\b(?:who is|who was|tell me about|what do you know about|about)\b/i;
const RELATIONSHIP_QUERY_RE =
  /\b(?:relationship|partner|wife|husband|friend|colleague|work with)\b/i;
const CONTRADICTION_QUERY_RE =
  /\b(?:contradict|inconsistent|conflict|changed my mind|consistent|flip-flop)\b/i;
const TIMELINE_QUERY_RE =
  /\b(?:when|timeline|happened|history|chronolog|first|last|recently)\b/i;
const OPEN_LOOP_QUERY_RE =
  /\b(?:todo|pending|haven't done|still need|follow up|forgot to|supposed to|open loop|unfinished)\b/i;
const BELIEF_QUERY_RE =
  /\b(?:believe|think|opinion|value|priority|principle|philosophy|what do i think|what matters)\b/i;

export interface ClassifiedQuery {
  strategy: QueryStrategy;
  reason: string;
  entityHint: string | null;
}

export function classifyQueryIntent(query: string): ClassifiedQuery {
  const text = query.trim();
  if (!text) {
    return { strategy: "quick_context", reason: "empty", entityHint: null };
  }

  // Check for contradiction queries first (highest priority for the "mirror")
  if (CONTRADICTION_QUERY_RE.test(text)) {
    return {
      strategy: "contradiction_check",
      reason: "contradiction_keywords",
      entityHint: extractEntityHint(text),
    };
  }

  if (OPEN_LOOP_QUERY_RE.test(text)) {
    return {
      strategy: "open_loop_check",
      reason: "open_loop_keywords",
      entityHint: extractEntityHint(text),
    };
  }

  if (BELIEF_QUERY_RE.test(text)) {
    return {
      strategy: "belief_check",
      reason: "belief_keywords",
      entityHint: extractEntityHint(text),
    };
  }

  if (ENTITY_QUERY_RE.test(text) && RELATIONSHIP_QUERY_RE.test(text)) {
    return {
      strategy: "relationship_brief",
      reason: "relationship_entity",
      entityHint: extractEntityHint(text),
    };
  }

  if (ENTITY_QUERY_RE.test(text)) {
    return {
      strategy: "entity_brief",
      reason: "entity_query",
      entityHint: extractEntityHint(text),
    };
  }

  if (TIMELINE_QUERY_RE.test(text)) {
    return {
      strategy: "timeline_brief",
      reason: "temporal_keywords",
      entityHint: extractEntityHint(text),
    };
  }

  return { strategy: "quick_context", reason: "default", entityHint: null };
}

function extractEntityHint(query: string): string | null {
  const match = query.match(
    /\b(?:who is|about|tell me about|what do you know about)\s+([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*)/i
  );
  return match?.[1]?.trim() ?? null;
}

// ── World model context for recall injection ─────────────────────────────────

export function buildWorldModelContext(query: string): string {
  const classified = classifyQueryIntent(query);
  const lines: string[] = [];

  lines.push(`<world-model strategy="${classified.strategy}">`);

  if (
    classified.strategy === "contradiction_check" ||
    classified.strategy === "quick_context"
  ) {
    const contradictions = listContradictions(true);
    if (contradictions.length > 0) {
      lines.push("  <contradictions>");
      for (const c of contradictions.slice(0, 5)) {
        lines.push(`    <contradiction>`);
        lines.push(`      <earlier>${c.statementA}</earlier>`);
        lines.push(`      <later>${c.statementB}</later>`);
        lines.push(`      <detected>${c.detectedAt}</detected>`);
        lines.push(`    </contradiction>`);
      }
      lines.push("  </contradictions>");
    }
  }

  if (
    classified.strategy === "open_loop_check" ||
    classified.strategy === "quick_context"
  ) {
    const loops = listOpenLoops("open");
    if (loops.length > 0) {
      lines.push("  <open-loops>");
      for (const ol of loops.slice(0, 5)) {
        lines.push(`    <loop detected="${ol.detectedAt}">${ol.content}</loop>`);
      }
      lines.push("  </open-loops>");
    }
  }

  if (classified.strategy === "belief_check") {
    const beliefs = listBeliefs("active");
    if (beliefs.length > 0) {
      lines.push("  <beliefs>");
      for (const b of beliefs.slice(0, 8)) {
        lines.push(`    <belief stated="${b.lastStated}">${b.content}</belief>`);
      }
      lines.push("  </beliefs>");
    }
  }

  if (
    classified.strategy === "entity_brief" ||
    classified.strategy === "relationship_brief"
  ) {
    if (classified.entityHint) {
      const entity = findEntityByName(classified.entityHint);
      if (entity) {
        lines.push(`  <entity name="${entity.name}" kind="${entity.kind}">`);
        lines.push(`    <first-seen>${entity.firstSeen}</first-seen>`);
        lines.push(`    <last-seen>${entity.lastSeen}</last-seen>`);
        lines.push(`    <mentions>${entity.mentionCount}</mentions>`);
        if (entity.summary) {
          lines.push(`    <summary>${entity.summary}</summary>`);
        }
        lines.push(`  </entity>`);
      }
    } else {
      // List top entities
      const entities = listEntities().slice(0, 10);
      if (entities.length > 0) {
        lines.push("  <entities>");
        for (const e of entities) {
          lines.push(
            `    <entity name="${e.name}" kind="${e.kind}" mentions="${e.mentionCount}" />`
          );
        }
        lines.push("  </entities>");
      }
    }
  }

  lines.push("</world-model>");

  return lines.join("\n");
}
