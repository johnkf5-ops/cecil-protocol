import fs from "fs/promises";
import path from "path";
import { chatCompletion } from "./llm";
import { embed, embedBatch, initCollection } from "./embedder";
import { recordMemoryWrite } from "./memory-store";
import { getRecentByType } from "./retriever";
import { ensureWorldModelSchema, extractWorldData, upsertEntity, recordEntityMention, recordBelief, recordOpenLoop, recordContradiction, findEntityByName, getWorldModelSummary, listEntities, listBeliefs } from "./world-model";
import type { Message, SessionCounter } from "./types";

const MEMORY_DIR = path.join(process.cwd(), "memory");
const IDENTITY_DIR = path.join(process.cwd(), "identity");
const COUNTER_PATH = path.join(MEMORY_DIR, ".session-counter.json");

function getSynthesisInterval(): number {
  return parseInt(process.env.SYNTHESIS_INTERVAL || "3", 10);
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function getSessionCounter(): Promise<SessionCounter> {
  const raw = await readFileOrNull(COUNTER_PATH);
  if (raw) {
    return JSON.parse(raw);
  }
  return { count: 0, lastFullSynthesis: 0 };
}

async function saveSessionCounter(counter: SessionCounter): Promise<void> {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  await fs.writeFile(COUNTER_PATH, JSON.stringify(counter, null, 2), "utf-8");
}

/**
 * Format a conversation into a readable log.
 */
function formatConversationLog(messages: Message[], sessionId: string): string {
  const lines = messages.map(
    (m) => `**${m.role === "user" ? "User" : "Cecil"}:** ${m.content}`
  );
  return `# Session ${sessionId}\n\n${lines.join("\n\n")}\n`;
}

/**
 * Light pass — runs every session. No LLM calls.
 * Logs the conversation to markdown and embeds it into Qdrant.
 */
async function lightPass(
  messages: Message[],
  sessionId: string
): Promise<boolean> {
  await initCollection();

  const conversationDir = path.join(MEMORY_DIR, "conversations");
  await fs.mkdir(conversationDir, { recursive: true });

  // Write human-readable markdown log
  const log = formatConversationLog(messages, sessionId);
  const logPath = path.join(conversationDir, `${sessionId}.md`);
  try {
    await fs.writeFile(logPath, log, { encoding: "utf-8", flag: "wx" });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return false;
    }
    throw error;
  }

  // Embed the full conversation as one vector
  const fullText = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const now = new Date().toISOString();

  await embed(fullText, {
    type: "conversation",
    timestamp: now,
    sessionId,
    sourcePath: `memory/conversations/${sessionId}.md`,
    sourceType: "conversation_session",
    sourceId: sessionId,
    qualityScore: 0.65,
    provenance: {
      writer: "observer.light-pass",
      granularity: "session",
      messageCount: messages.length,
      userMessageCount: messages.filter((m) => m.role === "user").length,
    },
  });

  await recordMemoryWrite({
    eventId: `conversation:${sessionId}:captured`,
    memoryKey: `conversation:${sessionId}`,
    memoryType: "conversation",
    action: "capture",
    text: fullText,
    timestamp: now,
    sessionId,
    sourceType: "conversation_session",
    sourcePath: `memory/conversations/${sessionId}.md`,
    sourceId: sessionId,
    qualityScore: 0.65,
    provenance: {
      writer: "observer.light-pass",
      granularity: "session",
      messageCount: messages.length,
      userMessageCount: messages.filter((m) => m.role === "user").length,
    },
  });

  // Also embed each user message individually for granular retrieval
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length > 0) {
    await embedBatch(
      userMessages.map((m) => ({
        text: m.content,
        metadata: {
          type: "conversation" as const,
          timestamp: now,
          sessionId,
          sourceType: "conversation_session" as const,
          sourceId: sessionId,
          qualityScore: 0.55,
          provenance: {
            writer: "observer.light-pass",
            granularity: "user-message",
          },
        },
      }))
    );
  }

  // World model extraction — extract entities, beliefs, open loops, contradictions
  try {
    ensureWorldModelSchema();
    const extracted = await extractWorldData(fullText);

    for (const e of extracted.entities) {
      if (!e.name || !e.kind) continue;
      const entity = upsertEntity(e.name, e.kind, now);
      recordEntityMention(entity.entityId, `conversation:${sessionId}`, now);
    }

    for (const b of extracted.beliefs) {
      if (!b.content) continue;
      const entityId = b.aboutEntity
        ? findEntityByName(b.aboutEntity)?.entityId ?? null
        : null;
      recordBelief(b.content, entityId, `conversation:${sessionId}`, now);
    }

    for (const ol of extracted.openLoops) {
      if (!ol.content) continue;
      const entityId = ol.aboutEntity
        ? findEntityByName(ol.aboutEntity)?.entityId ?? null
        : null;
      recordOpenLoop(ol.content, entityId, now);
    }

    for (const c of extracted.contradictions) {
      if (!c.statementA || !c.statementB) continue;
      const entityId = c.aboutEntity
        ? findEntityByName(c.aboutEntity)?.entityId ?? null
        : null;
      recordContradiction(
        c.statementA,
        c.statementB,
        `conversation:${sessionId}`,
        `conversation:${sessionId}`,
        entityId,
        now
      );
    }
  } catch (err) {
    // World model extraction is non-critical — don't fail the observer
    console.error("[observer] world model extraction failed:", err);
  }

  return true;
}

/**
 * Full synthesis — runs every N sessions. 3-5 LLM calls.
 * Detects patterns, updates narrative, updates delta, writes observations.
 */
async function fullSynthesis(sessionId: string): Promise<void> {
  // Gather context: recent conversations + existing identity
  const [recentConversations, recentObservations, seed, narrative, delta] =
    await Promise.all([
      getRecentByType("conversation", 15),
      getRecentByType("observation", 10),
      readFileOrNull(path.join(IDENTITY_DIR, "seed.md")),
      readFileOrNull(path.join(IDENTITY_DIR, "narrative.md")),
      readFileOrNull(path.join(IDENTITY_DIR, "delta.md")),
    ]);

  // Build baseline context — seed if available, otherwise world model summary
  let baseline: string;
  if (seed) {
    baseline = seed;
  } else {
    try {
      ensureWorldModelSchema();
      const summary = getWorldModelSummary();
      const topEntities = listEntities().slice(0, 10);
      const topBeliefs = listBeliefs("active").slice(0, 8);
      const entityLines = topEntities.map((e) => `- ${e.name} (${e.kind}, ${e.mentionCount} mentions)`);
      const beliefLines = topBeliefs.map((b) => `- ${b.content}`);
      baseline = [
        `World model: ${summary.entities} entities, ${summary.beliefs} beliefs, ${summary.openLoops} open loops, ${summary.contradictions} contradictions`,
        entityLines.length > 0 ? `\nTop entities:\n${entityLines.join("\n")}` : "",
        beliefLines.length > 0 ? `\nActive beliefs:\n${beliefLines.join("\n")}` : "",
      ].filter(Boolean).join("\n");
    } catch {
      baseline = "No baseline available yet — synthesizing from conversation data only.";
    }
  }

  const conversationTexts = recentConversations.map((r) => r.text).join("\n---\n");
  const observationTexts = recentObservations.map((r) => r.text).join("\n");

  if (!conversationTexts.trim()) return; // Nothing to synthesize

  // --- LLM Call 1: Detect patterns ---
  const patterns = await chatCompletion({
    system: `You are an observer module for a personal assistant with persistent memory. Your job is to analyze recent conversations and detect patterns. Look for:
- Recurring themes, priorities, or focal points
- Shifts in direction or emphasis over time
- Contradictions between stated intent and observed behavior
- Evolution in approach, strategy, or goals
- Significant decisions or turning points
- New information about the user (name, role, preferences, relationships)

Be specific and evidence-based. Cite what you observed. Output a concise list of patterns.`,
    messages: [
      {
        role: "user",
        content: `Here is the current baseline:\n${baseline}\n\nPrevious observations:\n${observationTexts || "None yet."}\n\nRecent conversations:\n${conversationTexts}\n\nWhat patterns do you observe?`,
      },
    ],
    maxTokens: 2048,
  });

  // --- LLM Call 2: Update narrative ---
  const newNarrative = await chatCompletion({
    system: `You are updating a living narrative document. This document tracks the evolving understanding of a person — not a static summary, but a picture that changes as new patterns emerge from conversation.

Be direct and specific. Include evidence from the data. The narrative should synthesize what the patterns reveal into a coherent, evolving understanding.

Output ONLY the updated narrative content in markdown. Start with "# Narrative" as the heading.`,
    messages: [
      {
        role: "user",
        content: `Current baseline:\n${baseline}\n\nCurrent narrative:\n${narrative || "No narrative yet."}\n\nNewly detected patterns:\n${patterns}\n\nWrite the updated narrative.`,
      },
    ],
    maxTokens: 2048,
  });

  // --- LLM Call 3: Update delta ---
  const newDelta = await chatCompletion({
    system: `You are computing the delta — the drift between the current baseline understanding and newly observed patterns. The delta captures where the data diverges from what was previously known.

Identify where observed behavior, themes, or priorities differ from the baseline. This is signal detection, not judgment. If there is no meaningful drift, say so — don't fabricate gaps.

Be specific. Reference evidence from the data.

Output ONLY the delta content in markdown. Start with "# Delta" as the heading.`,
    messages: [
      {
        role: "user",
        content: `Current baseline:\n${baseline}\n\nCurrent narrative (observed):\n${newNarrative}\n\nPrevious delta:\n${delta || "No delta yet."}\n\nDetected patterns:\n${patterns}\n\nCompute the updated delta.`,
      },
    ],
    maxTokens: 2048,
  });

  // Write updated identity files
  await Promise.all([
    fs.writeFile(path.join(IDENTITY_DIR, "narrative.md"), newNarrative, "utf-8"),
    fs.writeFile(path.join(IDENTITY_DIR, "delta.md"), newDelta, "utf-8"),
  ]);

  // Write observation to markdown
  const obsDir = path.join(MEMORY_DIR, "observations");
  await fs.mkdir(obsDir, { recursive: true });
  const obsPath = path.join(obsDir, `${sessionId}.md`);
  await fs.writeFile(
    obsPath,
    `# Observation — ${sessionId}\n\n${patterns}\n`,
    "utf-8"
  );

  // Embed the observation
  const now = new Date().toISOString();
  await embed(patterns, {
    type: "observation",
    timestamp: now,
    sessionId,
    sourcePath: `memory/observations/${sessionId}.md`,
    sourceType: "observer_synthesis",
    sourceId: sessionId,
    qualityScore: 0.85,
    provenance: {
      writer: "observer.full-synthesis",
      synthesisInterval: getSynthesisInterval(),
      basedOnConversationCount: recentConversations.length,
      basedOnObservationCount: recentObservations.length,
    },
  });

  await recordMemoryWrite({
    eventId: `observation:${sessionId}:captured`,
    memoryKey: `observation:${sessionId}`,
    memoryType: "observation",
    action: "capture",
    text: patterns,
    timestamp: now,
    sessionId,
    sourceType: "observer_synthesis",
    sourcePath: `memory/observations/${sessionId}.md`,
    sourceId: sessionId,
    qualityScore: 0.85,
    provenance: {
      writer: "observer.full-synthesis",
      synthesisInterval: getSynthesisInterval(),
      basedOnConversationCount: recentConversations.length,
      basedOnObservationCount: recentObservations.length,
    },
  });
}

/**
 * Run the observer pipeline. Called after every chat session.
 * Always does a light pass. Does full synthesis every N sessions.
 */
export async function observe(
  messages: Message[],
  sessionId: string
): Promise<{ didSynthesize: boolean; alreadyObserved?: boolean }> {
  // Always: light pass (no LLM calls)
  const recorded = await lightPass(messages, sessionId);
  if (!recorded) {
    return { didSynthesize: false, alreadyObserved: true };
  }

  // Increment session counter
  const counter = await getSessionCounter();
  counter.count += 1;

  const interval = getSynthesisInterval();
  const sessionsSinceSynthesis = counter.count - counter.lastFullSynthesis;
  let didSynthesize = false;

  // Full synthesis if we've hit the interval
  if (sessionsSinceSynthesis >= interval) {
    await fullSynthesis(sessionId);
    counter.lastFullSynthesis = counter.count;
    didSynthesize = true;
  }

  await saveSessionCounter(counter);
  return { didSynthesize };
}
