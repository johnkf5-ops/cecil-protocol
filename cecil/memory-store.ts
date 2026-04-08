import fs from "fs/promises";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import type { MemorySourceType, MemoryType } from "./types";
import { detectDomain } from "./domain";

let cachedSubjectName: string | null = null;
let cachedSubjectTokens: string[] = [];

/**
 * Resolve the subject's name. Priority:
 * 1. Runtime override (setSubjectName)
 * 2. identity/seed.md **Name:** field
 * 3. World model — person entity with highest mention count
 * 4. Fallback: "the user"
 */
export async function loadSubjectName(): Promise<string> {
  if (cachedSubjectName) return cachedSubjectName;

  // Try seed.md first
  try {
    const seedPath = path.join(process.cwd(), "identity", "seed.md");
    const seed = await fs.readFile(seedPath, "utf-8");
    const match = seed.match(/\*\*Name:\*\*\s*(.+)/i);
    if (match) {
      cachedSubjectName = match[1].trim();
      cachedSubjectTokens = cachedSubjectName
        .toLowerCase()
        .split(/\s+/)
        .filter((t: string) => t.length >= 3);
      return cachedSubjectName;
    }
  } catch {
    // No seed file — try world model
  }

  // Fall back to world model: find the person entity with highest mention count
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT name FROM world_entities WHERE kind = 'person' ORDER BY mention_count DESC, last_seen DESC LIMIT 1`
      )
      .get<{ name: string }>();
    if (row?.name) {
      cachedSubjectName = row.name;
      cachedSubjectTokens = cachedSubjectName
        .toLowerCase()
        .split(/\s+/)
        .filter((t: string) => t.length >= 3);
      return cachedSubjectName;
    }
  } catch {
    // World model tables may not exist yet — that's fine
  }

  cachedSubjectName = "the user";
  cachedSubjectTokens = [];
  return cachedSubjectName;
}

/**
 * Set the subject name at runtime (e.g. learned from conversation).
 * Clears the cache so subsequent calls use the new name.
 */
export function setSubjectName(name: string): void {
  cachedSubjectName = name.trim();
  cachedSubjectTokens = cachedSubjectName
    .toLowerCase()
    .split(/\s+/)
    .filter((t: string) => t.length >= 3);
}

function getSubjectTokens(): string[] {
  return cachedSubjectTokens;
}

const MEMORY_DIR = path.join(process.cwd(), "memory");
export const STRUCTURED_MEMORY_DB_PATH = path.join(
  MEMORY_DIR,
  "structured-memory.sqlite"
);

let database: DatabaseSync | null = null;
let schemaInitialized = false;

export type StructuredMemoryAction = "capture" | "upsert" | "retire";

export interface StructuredMemoryWrite {
  eventId: string;
  memoryKey: string;
  memoryType: MemoryType;
  action: StructuredMemoryAction;
  text: string;
  timestamp: string;
  sessionId?: string;
  sourceType: MemorySourceType;
  sourcePath?: string;
  sourceId?: string;
  sourceEpisode?: string;
  domain?: string;
  qualityScore?: number;
  provenance?: Record<string, unknown>;
}

interface StructuredMemoryRowRecord {
  memory_key: string;
  memory_type: MemoryType;
  text: string;
  session_id: string | null;
  source_type: MemorySourceType;
  source_path: string | null;
  source_id: string | null;
  source_episode: string | null;
  domain: string | null;
  provenance_json: string;
  quality_score: number;
  created_at: string;
  updated_at?: string;
  action?: StructuredMemoryAction;
  event_id?: string;
}

export interface StructuredMemoryRecord {
  memoryKey: string;
  memoryType: MemoryType;
  text: string;
  sessionId?: string;
  sourceType: MemorySourceType;
  sourcePath?: string;
  sourceId?: string;
  sourceEpisode?: string;
  domain: string;
  provenance: Record<string, unknown>;
  qualityScore: number;
  createdAt: string;
  updatedAt: string;
}

export interface StructuredMemoryEventRecord extends StructuredMemoryRecord {
  eventId: string;
  action: StructuredMemoryAction;
}

export interface StructuredMemoryQueryOptions {
  types?: MemoryType[];
  sessionId?: string;
  sourceType?: MemorySourceType;
  sourceEpisode?: string;
  limit?: number;
}

export interface RankedRecallCandidate extends StructuredMemoryRecord {
  lexicalHits: number;
  recallScore: number;
}

function getDatabase(): DatabaseSync {
  if (!database) {
    database = new DatabaseSync(STRUCTURED_MEMORY_DB_PATH);
  }

  return database;
}

function clampQualityScore(value?: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, value));
}

function buildProvenanceJson(write: StructuredMemoryWrite): string {
  return JSON.stringify({
    ...write.provenance,
    memoryKey: write.memoryKey,
    memoryType: write.memoryType,
    sourceType: write.sourceType,
    sourcePath: write.sourcePath ?? null,
    sourceId: write.sourceId ?? null,
    sourceEpisode: write.sourceEpisode ?? null,
    sessionId: write.sessionId ?? null,
    recordedAt: write.timestamp,
  });
}

function parseProvenanceJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapRow(
  row: StructuredMemoryRowRecord
): StructuredMemoryRecord | StructuredMemoryEventRecord {
  const baseRecord: StructuredMemoryRecord = {
    memoryKey: row.memory_key,
    memoryType: row.memory_type,
    text: row.text,
    sessionId: row.session_id ?? undefined,
    sourceType: row.source_type,
    sourcePath: row.source_path ?? undefined,
    sourceId: row.source_id ?? undefined,
    sourceEpisode: row.source_episode ?? undefined,
    domain: row.domain ?? "general",
    provenance: parseProvenanceJson(row.provenance_json),
    qualityScore: row.quality_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };

  if (row.event_id && row.action) {
    return {
      ...baseRecord,
      eventId: row.event_id,
      action: row.action,
    };
  }

  return baseRecord;
}

export function ensureColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all<{ name: string }>();
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function buildWhereClause(options: StructuredMemoryQueryOptions): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.types && options.types.length > 0) {
    conditions.push(
      `memory_type IN (${options.types.map(() => "?").join(", ")})`
    );
    params.push(...options.types);
  }

  if (options.sessionId) {
    conditions.push("session_id = ?");
    params.push(options.sessionId);
  }

  if (options.sourceType) {
    conditions.push("source_type = ?");
    params.push(options.sourceType);
  }

  if (options.sourceEpisode) {
    conditions.push("source_episode = ?");
    params.push(options.sourceEpisode);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

const QUERY_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "into",
  "is",
  "it",
  "know",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "remember",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "these",
  "they",
  "this",
  "those",
  "to",
  "us",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

const VALUE_INTENT_TOKENS = new Set([
  "believe",
  "belief",
  "care",
  "cares",
  "important",
  "matters",
  "meaning",
  "priorities",
  "priority",
  "think",
  "thinks",
  "value",
  "values",
]);

const BELIEF_INTENT_TOKENS = new Set([
  "believe",
  "belief",
  "think",
  "thinks",
]);

const VALUE_PRIORITY_INTENT_TOKENS = new Set([
  "care",
  "cares",
  "important",
  "matters",
  "priorities",
  "priority",
  "value",
  "values",
]);

const OPINION_CATEGORIES = new Set(["opinion", "preference"]);
const IDENTITY_OBSERVATION_FACETS = new Set([
  "values",
  "priorities",
  "beliefs",
  "preferences",
  "working_style",
  "communication_style",
  "tensions",
]);
const IDENTITY_FOCUS_TOKENS = new Set([
  "believe",
  "cares",
  "conviction",
  "important",
  "matters",
  "priority",
  "priorities",
  "thinks",
  "value",
  "values",
]);
function getIdentityFocusPhrases(): string[] {
  const tokens = getSubjectTokens();
  const name = tokens.join(" ");
  return [
    `matters to ${name}`,
    "care about",
    "cares about",
    `important to ${name}`,
    `what drives ${name}`,
    `what ${name} believes`,
    `what ${name} cares about`,
    `what ${name} thinks`,
  ];
}

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isIdentityValueQuery(normalizedQuery: string, tokens: string[]): boolean {
  const subjectTokens = getSubjectTokens();
  const hasSubjectFocus = subjectTokens.length > 0 &&
    subjectTokens.some((token) => new RegExp(`\\b${token}\\b`).test(normalizedQuery));
  const hasIdentityToken = tokens.some((token) => IDENTITY_FOCUS_TOKENS.has(token));
  const hasIdentityPhrase = getIdentityFocusPhrases().some((phrase) =>
    normalizedQuery.includes(phrase)
  );

  return hasSubjectFocus && (hasIdentityToken || hasIdentityPhrase);
}

function tokenizeQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
    .slice(0, 12);

  const filtered = rawTokens.filter((token) => !QUERY_STOPWORDS.has(token));
  const tokens = filtered.length > 0 ? filtered : rawTokens;

  return Array.from(new Set(tokens)).slice(0, 8);
}

export async function initStructuredMemory(): Promise<void> {
  if (schemaInitialized) {
    return;
  }

  await fs.mkdir(MEMORY_DIR, { recursive: true });

  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_current (
      memory_key TEXT PRIMARY KEY,
      memory_type TEXT NOT NULL,
      text TEXT NOT NULL,
      session_id TEXT,
      source_type TEXT NOT NULL,
      source_path TEXT,
      source_id TEXT,
      source_episode TEXT,
      provenance_json TEXT NOT NULL,
      quality_score REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      memory_key TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      action TEXT NOT NULL,
      text TEXT NOT NULL,
      session_id TEXT,
      source_type TEXT NOT NULL,
      source_path TEXT,
      source_id TEXT,
      source_episode TEXT,
      provenance_json TEXT NOT NULL,
      quality_score REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  ensureColumn(db, "memory_current", "source_episode", "TEXT");
  ensureColumn(db, "memory_events", "source_episode", "TEXT");
  ensureColumn(db, "memory_current", "domain", "TEXT DEFAULT 'general'");
  ensureColumn(db, "memory_events", "domain", "TEXT DEFAULT 'general'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_current_type
      ON memory_current (memory_type, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_current_session
      ON memory_current (session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_type
      ON memory_events (memory_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_events_session
      ON memory_events (session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_current_source_episode
      ON memory_current (source_episode, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_events_source_episode
      ON memory_events (source_episode, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_current_domain
      ON memory_current (domain, updated_at DESC);
  `);

  schemaInitialized = true;
}

export async function recordMemoryWrite(
  write: StructuredMemoryWrite
): Promise<void> {
  await initStructuredMemory();

  const db = getDatabase();
  const qualityScore = clampQualityScore(write.qualityScore);
  const provenanceJson = buildProvenanceJson(write);

  const upsertCurrent = db.prepare(`
    INSERT INTO memory_current (
      memory_key,
      memory_type,
      text,
      session_id,
      source_type,
      source_path,
      source_id,
      source_episode,
      domain,
      provenance_json,
      quality_score,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_key) DO UPDATE SET
      memory_type = excluded.memory_type,
      text = excluded.text,
      session_id = excluded.session_id,
      source_type = excluded.source_type,
      source_path = excluded.source_path,
      source_id = excluded.source_id,
      source_episode = excluded.source_episode,
      domain = excluded.domain,
      provenance_json = excluded.provenance_json,
      quality_score = excluded.quality_score,
      updated_at = excluded.updated_at
  `);

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO memory_events (
      event_id,
      memory_key,
      memory_type,
      action,
      text,
      session_id,
      source_type,
      source_path,
      source_id,
      source_episode,
      domain,
      provenance_json,
      quality_score,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteCurrent = db.prepare(`
    DELETE FROM memory_current
    WHERE memory_key = ?
  `);

  db.exec("BEGIN");

  try {
    if (write.action === "retire") {
      deleteCurrent.run(write.memoryKey);
    } else {
      upsertCurrent.run(
        write.memoryKey,
        write.memoryType,
        write.text,
        write.sessionId ?? null,
        write.sourceType,
        write.sourcePath ?? null,
        write.sourceId ?? null,
        write.sourceEpisode ?? null,
        write.domain ?? "general",
        provenanceJson,
        qualityScore,
        write.timestamp,
        write.timestamp
      );
    }

    insertEvent.run(
      write.eventId,
      write.memoryKey,
      write.memoryType,
      write.action,
      write.text,
      write.sessionId ?? null,
      write.sourceType,
      write.sourcePath ?? null,
      write.sourceId ?? null,
      write.sourceEpisode ?? null,
      write.domain ?? "general",
      provenanceJson,
      qualityScore,
      write.timestamp
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function getCurrentMemories(
  options: StructuredMemoryQueryOptions = {}
): Promise<StructuredMemoryRecord[]> {
  await initStructuredMemory();

  const db = getDatabase();
  const { clause, params } = buildWhereClause(options);
  const limit = options.limit ?? 20;
  const rows = db
    .prepare(`
      SELECT
        memory_key,
        memory_type,
        text,
        session_id,
        source_type,
        source_path,
        source_id,
        source_episode,
        domain,
        provenance_json,
        quality_score,
        created_at,
        updated_at
      FROM memory_current
      ${clause}
      ORDER BY updated_at DESC, quality_score DESC
      LIMIT ?
    `)
    .all<StructuredMemoryRowRecord>(...params, limit);

  return rows.map((row) => mapRow(row) as StructuredMemoryRecord);
}

export async function getMemoryEvents(
  options: StructuredMemoryQueryOptions = {}
): Promise<StructuredMemoryEventRecord[]> {
  await initStructuredMemory();

  const db = getDatabase();
  const { clause, params } = buildWhereClause(options);
  const limit = options.limit ?? 50;
  const rows = db
    .prepare(`
      SELECT
        event_id,
        memory_key,
        memory_type,
        action,
        text,
        session_id,
        source_type,
        source_path,
        source_id,
        source_episode,
        domain,
        provenance_json,
        quality_score,
        created_at
      FROM memory_events
      ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all<StructuredMemoryRowRecord>(...params, limit);

  return rows.map((row) => mapRow(row) as StructuredMemoryEventRecord);
}

export async function getRankedRecallCandidates(
  query: string,
  options: StructuredMemoryQueryOptions = {}
): Promise<RankedRecallCandidate[]> {
  await initStructuredMemory();
  await loadSubjectName();

  const db = getDatabase();
  const tokens = tokenizeQuery(query);
  const normalizedQuery = normalizeForSearch(query);
  const valueIntent = tokens.some((token) => VALUE_INTENT_TOKENS.has(token));
  const beliefIntent = tokens.some((token) => BELIEF_INTENT_TOKENS.has(token));
  const valuePriorityIntent = tokens.some((token) =>
    VALUE_PRIORITY_INTENT_TOKENS.has(token)
  );
  const identityValueQuery = isIdentityValueQuery(normalizedQuery, tokens);
  const queryDomain = detectDomain(query);
  const isQuestion = /\?$|^(what|how|when|where|why|who|did)\b/i.test(query);
  const { clause, params } = buildWhereClause(options);
  const limit = options.limit ?? 20;
  const poolLimit = Math.max(limit * 8, 80);
  const tokenExpressions = tokens.map(
    () => "CASE WHEN lower(text) LIKE ? THEN 1 ELSE 0 END"
  );
  const lexicalSelect = tokenExpressions.length > 0
    ? `(${tokenExpressions.join(" + ")})`
    : "0";
  const tokenConditions = tokens.length > 0
    ? tokens.map(() => "lower(text) LIKE ?").join(" OR ")
    : "";
  const tokenValues = tokens.map((token) => `%${token}%`);
  const textClause = tokens.length > 0
    ? `${clause ? `${clause} AND` : "WHERE"} (${tokenConditions})`
    : clause;

  const rows = db
    .prepare(`
      SELECT
        memory_key,
        memory_type,
        text,
        session_id,
        source_type,
        source_path,
        source_id,
        source_episode,
        domain,
        provenance_json,
        quality_score,
        created_at,
        updated_at,
        ${lexicalSelect} AS lexical_hits
      FROM memory_current
      ${textClause}
      ORDER BY lexical_hits DESC, quality_score DESC, updated_at DESC
      LIMIT ?
    `)
    .all<(StructuredMemoryRowRecord & { lexical_hits: number })>(
      ...tokenValues,
      ...params,
      ...tokenValues,
      poolLimit
    );

  const tokenWeights = new Map<string, number>();
  const documentCount = Math.max(rows.length, 1);

  for (const token of tokens) {
    const matchCount = rows.reduce((count, row) => {
      return row.text.toLowerCase().includes(token) ? count + 1 : count;
    }, 0);

    const weight = Math.log((documentCount + 1) / (matchCount + 1)) + 1;
    tokenWeights.set(token, weight);
  }

  const ranked = rows
    .map((row) => {
      const record = mapRow(row) as StructuredMemoryRecord;
      const normalizedText = normalizeForSearch(record.text);
      const matchedTokens = tokens.filter((token) => normalizedText.includes(token));
      const lexicalHits = matchedTokens.length;
      const lexicalScore = matchedTokens.reduce(
        (sum, token) => sum + (tokenWeights.get(token) ?? 0),
        0
      );
      const category =
        typeof record.provenance.category === "string"
          ? record.provenance.category.toLowerCase()
          : "";
      const entities = Array.isArray(record.provenance.entities)
        ? record.provenance.entities
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.toLowerCase())
        : [];
      const hasValueLanguage = /\b(believe|believes|care|cares|important|matters|priority|priorities|think|thinks|value|values|prefers|conviction|goal|legacy)\b/.test(
        normalizedText
      );
      const provenanceSubjectName =
        typeof record.provenance.subjectName === "string"
          ? normalizeForSearch(record.provenance.subjectName)
          : "";
      const identityFacet =
        typeof record.provenance.facet === "string"
          ? record.provenance.facet.toLowerCase()
          : "";
      const subjectName = cachedSubjectName?.toLowerCase() ?? "";
      const sTokens = getSubjectTokens();
      const hasSubjectMatch =
        (subjectName && normalizedText.includes(subjectName)) ||
        sTokens.some((token) => entities.some((entity) => entity.includes(token))) ||
        sTokens.some((token) => provenanceSubjectName.includes(token));
      const querySubjectTokens = tokens.filter(
        (token) => !VALUE_INTENT_TOKENS.has(token)
      );
      const subjectMatch =
        querySubjectTokens.length > 0
          ? querySubjectTokens.some(
              (token) =>
                normalizedText.includes(token) ||
                entities.some((entity) => entity.includes(token)) ||
                provenanceSubjectName.includes(token)
            )
          : hasSubjectMatch;
      const isIdentityObservation =
        record.memoryType === "observation" &&
        IDENTITY_OBSERVATION_FACETS.has(identityFacet);
      const isIdentitySummaryObservation =
        record.memoryType === "observation" &&
        !isIdentityObservation &&
        (record.sourceId === "podcast-synthesis" ||
          record.sourceEpisode === "podcast-synthesis");
      const mentionsOtherPrimarySubject =
        /\bguest\b|\bhe\b|\bshe\b|\bthey\b/.test(normalizedText) ||
        entities.some(
          (entity) =>
            !sTokens.some((t) => entity.includes(t))
        );
      const subjectOnlyMatch =
        lexicalHits > 0 && matchedTokens.every((token) => sTokens.includes(token));

      let recallScore = lexicalScore + record.qualityScore;

      if (normalizedQuery.length >= 18 && normalizedText.includes(normalizedQuery)) {
        recallScore += 1.25;
      }

      if (valueIntent && OPINION_CATEGORIES.has(category)) {
        recallScore += 0.75;
      } else if (valueIntent && hasValueLanguage) {
        recallScore += 0.45;
      }

      if (identityValueQuery && hasSubjectMatch && hasValueLanguage) {
        recallScore += 1.2;
      }

      if (identityValueQuery && isIdentityObservation && subjectMatch) {
        recallScore += 2.6;
      }

      if (
        identityValueQuery &&
        isIdentityObservation &&
        (identityFacet === "values" ||
          identityFacet === "priorities" ||
          identityFacet === "beliefs")
      ) {
        recallScore += 0.9;
      }

      if (
        valuePriorityIntent &&
        isIdentityObservation &&
        (identityFacet === "values" || identityFacet === "priorities")
      ) {
        recallScore += 1.15;
      }

      if (valuePriorityIntent && isIdentityObservation && identityFacet === "beliefs") {
        recallScore -= 0.25;
      }

      if (beliefIntent && isIdentityObservation && identityFacet === "beliefs") {
        recallScore += 0.9;
      }

      if (identityValueQuery && isIdentitySummaryObservation) {
        recallScore -= 1.2;
      }

      if (identityValueQuery && OPINION_CATEGORIES.has(category) && hasSubjectMatch) {
        recallScore += 0.8;
      }

      if (identityValueQuery && mentionsOtherPrimarySubject && !hasSubjectMatch) {
        recallScore -= 1.1;
      }

      if (subjectOnlyMatch && !isIdentityObservation) {
        recallScore -= 0.75;
      }

      if (lexicalHits === 1) {
        recallScore -= 0.1;
      }

      // Domain boost
      if (queryDomain !== "general" && record.domain === queryDomain) {
        recallScore += 0.5;
      }

      // Exchange-pair boost for questions
      if (isQuestion && record.provenance?.granularity === "exchange-pair") {
        recallScore += 0.3;
      }

      return {
        ...record,
        lexicalHits,
        recallScore,
      };
    })
    .filter((record) => record.lexicalHits > 0)
    .sort((a, b) => {
      if (b.recallScore !== a.recallScore) {
        return b.recallScore - a.recallScore;
      }

      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  const deduped = new Map<string, RankedRecallCandidate>();

  for (const candidate of ranked) {
    const dedupeScope = candidate.sourceEpisode ?? candidate.sourcePath ?? "global";
    const dedupeKey = dedupeScope + "::" + normalizeForSearch(candidate.text).slice(0, 220);
    const existing = deduped.get(dedupeKey);

    if (!existing) {
      deduped.set(dedupeKey, candidate);
      continue;
    }

    const candidateBeatsExisting =
      (candidate.memoryType === "fact" && existing.memoryType === "milestone") ||
      (
        candidate.memoryType === existing.memoryType &&
        (
          candidate.recallScore > existing.recallScore ||
          (
            candidate.recallScore === existing.recallScore &&
            new Date(candidate.updatedAt).getTime() > new Date(existing.updatedAt).getTime()
          )
        )
      );

    if (candidateBeatsExisting) {
      deduped.set(dedupeKey, candidate);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => {
      if (b.recallScore !== a.recallScore) {
        return b.recallScore - a.recallScore;
      }

      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, limit);
}

