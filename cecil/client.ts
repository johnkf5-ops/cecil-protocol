/**
 * Cecil Client — Universal integration module.
 *
 * One import for any platform: Discord, Slack, Telegram, iMessage, custom bots.
 *
 * Usage:
 *   import { cecil } from "./cecil/client";
 *
 *   await cecil.init();
 *   const reply = await cecil.chat(messages);
 *   await cecil.observe(messages, sessionId);
 *   const memories = await cecil.recall("what do I care about?");
 *   const report = await cecil.reflect();
 */

import { initStructuredMemory, recordMemoryWrite, loadSubjectName, setSubjectName } from "./memory-store";
import { initCollection, embed } from "./embedder";
import { buildRecallWindow, type RecallWindow } from "./recall-window";
import { chat as metaChat } from "./meta";
import { observe as runObserver } from "./observer";
import { runReflection, type ReflectionReport, type ReflectionSection } from "./reflection";
import { runMaintenance, type MaintenanceReport, type MaintenanceOptions } from "./maintenance";
import {
  ensureWorldModelSchema,
  listEntities,
  listBeliefs,
  listOpenLoops,
  listContradictions,
  findEntityByName,
  getWorldModelSummary,
  beliefsAsOfDate,
  type EntityKind,
  type BeliefStatus,
  type OpenLoopStatus,
  type WorldEntity,
  type WorldBelief,
  type WorldOpenLoop,
  type WorldContradiction,
  type WorldModelSummary,
} from "./world-model";
import { handleCorrections } from "./correction-handler";
import type { Message } from "./types";
import { randomUUID } from "node:crypto";

let initialized = false;

/**
 * Initialize Cecil's memory systems. Call once at startup.
 * Safe to call multiple times — only initializes once.
 */
async function init(): Promise<void> {
  if (initialized) return;
  await initStructuredMemory();
  ensureWorldModelSchema();
  try {
    await initCollection();
  } catch {
    // Qdrant may not be running — structured memory still works
    console.warn("[cecil] Qdrant not available — vector search disabled");
  }
  initialized = true;
}

/**
 * Generate a session ID from the current timestamp.
 */
function sessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── Chat ─────────────────────────────────────────────────────────────────────

interface ChatResult {
  response: string;
  sessionId: string;
  usedDeepSearch: boolean;
}

/**
 * Send messages to Cecil and get a response.
 * Handles deep search automatically.
 */
async function chat(messages: Message[]): Promise<ChatResult> {
  await init();
  return metaChat(messages);
}

// ── Observe ──────────────────────────────────────────────────────────────────

interface ObserveResult {
  didSynthesize: boolean;
  alreadyObserved?: boolean;
  sessionId: string;
}

/**
 * Run the observer pipeline on a conversation.
 * Light pass every time, full synthesis every N sessions.
 * Also runs correction detection.
 */
async function observe(
  messages: Message[],
  sid?: string
): Promise<ObserveResult> {
  await init();
  const id = sid || sessionId();
  const result = await runObserver(messages, id);

  // Run correction handler in background
  loadSubjectName()
    .then((name) => handleCorrections(messages, id, name))
    .catch(() => {});

  return { ...result, sessionId: id };
}

// ── Recall ───────────────────────────────────────────────────────────────────

/**
 * Search Cecil's memory. Returns formatted context and raw snippets.
 */
async function recall(query: string): Promise<RecallWindow> {
  await init();
  return buildRecallWindow(query);
}

// ── Store ────────────────────────────────────────────────────────────────────

interface StoreOptions {
  type?: "conversation" | "observation" | "fact" | "milestone";
  qualityScore?: number;
  sessionId?: string;
  source?: string;
}

/**
 * Store a memory directly.
 */
async function store(
  content: string,
  options: StoreOptions = {}
): Promise<string> {
  await init();
  const type = options.type || "fact";
  const now = new Date().toISOString();
  const memoryKey = `${type}:client:${randomUUID().slice(0, 8)}`;

  try {
    await embed(content, {
      type,
      timestamp: now,
      sessionId: options.sessionId,
      sourceType: "conversation_session",
      sourceId: options.source || "client",
      qualityScore: options.qualityScore ?? 0.75,
      provenance: { writer: "cecil-client" },
    });
  } catch {
    // Qdrant may be down — still record to SQLite
  }

  await recordMemoryWrite({
    eventId: `${memoryKey}:captured`,
    memoryKey,
    memoryType: type,
    action: "capture",
    text: content,
    timestamp: now,
    sessionId: options.sessionId,
    sourceType: "conversation_session",
    sourceId: options.source || "client",
    qualityScore: options.qualityScore ?? 0.75,
    provenance: { writer: "cecil-client" },
  });

  return memoryKey;
}

// ── Reflect ──────────────────────────────────────────────────────────────────

/**
 * Run the reflection agent. Returns synthesized analysis.
 */
async function reflect(
  sections?: ReflectionSection[]
): Promise<ReflectionReport> {
  await init();
  return runReflection(sections);
}

// ── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Run the maintenance pipeline (dedup, quality sweep, refreshes).
 */
async function maintenance(
  options?: MaintenanceOptions
): Promise<MaintenanceReport> {
  await init();
  return runMaintenance(options);
}

// ── World Model ──────────────────────────────────────────────────────────────

/**
 * World model access — entities, beliefs, open loops, contradictions.
 */
const worldModel = {
  summary(): WorldModelSummary {
    ensureWorldModelSchema();
    return getWorldModelSummary();
  },

  entities(kind?: EntityKind): WorldEntity[] {
    ensureWorldModelSchema();
    return listEntities(kind);
  },

  findEntity(name: string): WorldEntity | null {
    ensureWorldModelSchema();
    return findEntityByName(name);
  },

  beliefs(status?: BeliefStatus): WorldBelief[] {
    ensureWorldModelSchema();
    return listBeliefs(status);
  },

  beliefsAsOf(date: string): WorldBelief[] {
    ensureWorldModelSchema();
    return beliefsAsOfDate(date);
  },

  openLoops(status?: OpenLoopStatus): WorldOpenLoop[] {
    ensureWorldModelSchema();
    return listOpenLoops(status);
  },

  contradictions(unresolvedOnly = true): WorldContradiction[] {
    ensureWorldModelSchema();
    return listContradictions(unresolvedOnly);
  },
};

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Get or set the subject's name.
 */
async function getSubjectName(): Promise<string> {
  await init();
  return loadSubjectName();
}

// ── Full-cycle helper ────────────────────────────────────────────────────────

interface TurnResult {
  response: string;
  sessionId: string;
  usedDeepSearch: boolean;
  observed: boolean;
}

/**
 * Full conversation turn: chat + observe in one call.
 * This is the simplest integration — send messages, get response,
 * memory is updated automatically.
 */
async function turn(messages: Message[]): Promise<TurnResult> {
  const chatResult = await chat(messages);

  // Add assistant response to messages for observer
  const fullMessages = [
    ...messages,
    { role: "assistant" as const, content: chatResult.response },
  ];

  // Observe in background — don't block the response
  const observePromise = observe(fullMessages, chatResult.sessionId)
    .catch((err) => console.error("[cecil] observe failed:", err));

  // Wait briefly for light pass, but don't block
  await Promise.race([
    observePromise,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

  return {
    response: chatResult.response,
    sessionId: chatResult.sessionId,
    usedDeepSearch: chatResult.usedDeepSearch,
    observed: true,
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

export const cecil = {
  init,
  chat,
  turn,
  observe,
  recall,
  store,
  reflect,
  maintenance,
  worldModel,
  getSubjectName,
  setSubjectName,
  sessionId,
};

export default cecil;
