/**
 * Reflection Agent — Introspects the world model and generates
 * LLM-synthesized reflections about contradictions, open loops,
 * focus analysis, and pattern summaries.
 */

import { chatCompletion } from "./llm";
import {
  ensureWorldModelSchema,
  listEntities,
  listBeliefs,
  listOpenLoops,
  listContradictions,
  getWorldModelSummary,
} from "./world-model";
import { getRecentByType } from "./retriever";

export interface ReflectionReport {
  contradictions: string;
  openLoops: string;
  focus: string;
  patterns: string;
  summary: WorldModelSummarySnapshot;
  generatedAt: string;
}

interface WorldModelSummarySnapshot {
  entities: number;
  beliefs: number;
  openLoops: number;
  contradictions: number;
}

export type ReflectionSection = "contradictions" | "openLoops" | "focus" | "patterns";

async function synthesizeContradictions(): Promise<string> {
  const contradictions = listContradictions(true);
  if (contradictions.length === 0) {
    return "No unresolved contradictions detected.";
  }

  const formatted = contradictions
    .slice(0, 10)
    .map(
      (c, i) =>
        `${i + 1}. Earlier: "${c.statementA}"\n   Later: "${c.statementB}"\n   Detected: ${c.detectedAt}`
    )
    .join("\n\n");

  return chatCompletion({
    system: `You are a reflection module for a personal assistant. Analyze the contradictions below and produce a concise report. For each contradiction:
- Explain what changed and whether it seems like growth, a genuine change of mind, or an inconsistency
- Suggest which statement is likely more current/accurate
- Flag any that seem important to surface to the user

Be direct. No filler. Output a clear, actionable report.`,
    messages: [
      {
        role: "user",
        content: `Here are the unresolved contradictions:\n\n${formatted}`,
      },
    ],
    maxTokens: 1024,
  });
}

async function synthesizeOpenLoops(): Promise<string> {
  const loops = listOpenLoops("open");
  if (loops.length === 0) {
    return "No open loops detected.";
  }

  const now = Date.now();
  const grouped = {
    fresh: [] as typeof loops,
    aging: [] as typeof loops,
    stale: [] as typeof loops,
  };

  for (const loop of loops) {
    const ageDays = (now - new Date(loop.detectedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 7) grouped.fresh.push(loop);
    else if (ageDays <= 30) grouped.aging.push(loop);
    else grouped.stale.push(loop);
  }

  const sections: string[] = [];
  if (grouped.fresh.length > 0) {
    sections.push("FRESH (< 7 days):\n" + grouped.fresh.map((ol) => `- ${ol.content}`).join("\n"));
  }
  if (grouped.aging.length > 0) {
    sections.push("AGING (7-30 days):\n" + grouped.aging.map((ol) => `- ${ol.content}`).join("\n"));
  }
  if (grouped.stale.length > 0) {
    sections.push("STALE (> 30 days):\n" + grouped.stale.map((ol) => `- ${ol.content}`).join("\n"));
  }

  return chatCompletion({
    system: `You are a reflection module for a personal assistant. Analyze these open loops (things the user said they'd do) grouped by age. For each group:
- Which still seem relevant?
- Which might have been silently resolved or abandoned?
- Which should the user be reminded about?

Be direct. Prioritize by importance, not just age.`,
    messages: [
      {
        role: "user",
        content: sections.join("\n\n"),
      },
    ],
    maxTokens: 1024,
  });
}

async function synthesizeFocusAnalysis(): Promise<string> {
  const entities = listEntities().slice(0, 20);
  const beliefs = listBeliefs("active").slice(0, 10);

  if (entities.length === 0) {
    return "Not enough data for focus analysis yet.";
  }

  const entityLines = entities.map(
    (e) => `- ${e.name} (${e.kind}): ${e.mentionCount} mentions, last seen ${e.lastSeen}`
  );
  const beliefLines = beliefs.map((b) => `- ${b.content}`);

  return chatCompletion({
    system: `You are a reflection module for a personal assistant. Analyze the user's focus based on entity mention frequency vs stated priorities/beliefs. Look for:
- Misalignment: things they say matter but rarely mention
- Hidden priorities: things they mention constantly but haven't stated as priorities
- Concentration: are they spread thin or focused?

Be specific and actionable.`,
    messages: [
      {
        role: "user",
        content: `Entity mention frequency:\n${entityLines.join("\n")}\n\nStated beliefs/priorities:\n${beliefLines.length > 0 ? beliefLines.join("\n") : "None recorded yet."}`,
      },
    ],
    maxTokens: 1024,
  });
}

async function synthesizePatterns(): Promise<string> {
  const [recentConversations, recentObservations] = await Promise.all([
    getRecentByType("conversation", 10),
    getRecentByType("observation", 5),
  ]);

  if (recentConversations.length === 0) {
    return "Not enough conversation data for pattern analysis yet.";
  }

  const convTexts = recentConversations
    .map((r) => r.text.slice(0, 500))
    .join("\n---\n");
  const obsTexts = recentObservations
    .map((r) => r.text.slice(0, 300))
    .join("\n---\n");

  return chatCompletion({
    system: `You are a reflection module for a personal assistant. Analyze recent conversations and observations to identify:
- Recurring themes and topics
- Emotional patterns (stress, excitement, indecision)
- Strategic direction (what they're building toward)
- Blind spots or areas they might be avoiding

Be concise. Focus on actionable insights.`,
    messages: [
      {
        role: "user",
        content: `Recent conversations:\n${convTexts}\n\nRecent observations:\n${obsTexts || "None yet."}`,
      },
    ],
    maxTokens: 1024,
  });
}

/**
 * Run reflection — generates a full or partial report.
 * Max 4 parallel LLM calls.
 */
export async function runReflection(
  sections?: ReflectionSection[]
): Promise<ReflectionReport> {
  ensureWorldModelSchema();
  const summary = getWorldModelSummary();

  const runAll = !sections || sections.length === 0;
  const runSection = (s: ReflectionSection) => runAll || sections!.includes(s);

  const [contradictions, openLoops, focus, patterns] = await Promise.all([
    runSection("contradictions")
      ? synthesizeContradictions()
      : Promise.resolve("(skipped)"),
    runSection("openLoops")
      ? synthesizeOpenLoops()
      : Promise.resolve("(skipped)"),
    runSection("focus")
      ? synthesizeFocusAnalysis()
      : Promise.resolve("(skipped)"),
    runSection("patterns")
      ? synthesizePatterns()
      : Promise.resolve("(skipped)"),
  ]);

  return {
    contradictions,
    openLoops,
    focus,
    patterns,
    summary: {
      entities: summary.entities,
      beliefs: summary.beliefs,
      openLoops: summary.openLoops,
      contradictions: summary.contradictions,
    },
    generatedAt: new Date().toISOString(),
  };
}
