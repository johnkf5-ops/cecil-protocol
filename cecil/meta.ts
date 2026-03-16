import fs from "fs/promises";
import path from "path";
import { buildRecallWindow } from "./recall-window";
import { generateResponse } from "./response-pipeline";
import { getRecentByType } from "./retriever";
import {
  ensureWorldModelSchema,
  getWorldModelSummary,
  listEntities,
  listBeliefs,
  listOpenLoops,
  listContradictions,
} from "./world-model";
import type { Message } from "./types";

const IDENTITY_DIR = path.join(process.cwd(), "identity");

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Build a world-model identity block when no seed.md exists.
 * Pulls top entities, active beliefs, open loops, and contradictions.
 */
function buildWorldModelIdentity(): string {
  try {
    ensureWorldModelSchema();
  } catch {
    return "";
  }

  const summary = getWorldModelSummary();
  if (summary.entities === 0 && summary.beliefs === 0) {
    return "";
  }

  const parts: string[] = [];

  const entities = listEntities().slice(0, 10);
  if (entities.length > 0) {
    const lines = entities.map(
      (e) => `- ${e.name} (${e.kind}, ${e.mentionCount} mentions)`
    );
    parts.push("=== KNOWN ENTITIES ===\n" + lines.join("\n"));
  }

  const beliefs = listBeliefs("active").slice(0, 8);
  if (beliefs.length > 0) {
    const lines = beliefs.map((b) => `- ${b.content}`);
    parts.push("=== ACTIVE BELIEFS ===\n" + lines.join("\n"));
  }

  const loops = listOpenLoops("open").slice(0, 5);
  if (loops.length > 0) {
    const lines = loops.map((ol) => `- ${ol.content} (since ${ol.detectedAt})`);
    parts.push("=== OPEN LOOPS ===\n" + lines.join("\n"));
  }

  const contradictions = listContradictions(true).slice(0, 5);
  if (contradictions.length > 0) {
    const lines = contradictions.map(
      (c) => `- Earlier: "${c.statementA}" vs Later: "${c.statementB}"`
    );
    parts.push("=== CONTRADICTIONS ===\n" + lines.join("\n"));
  }

  return parts.join("\n\n");
}

/**
 * Assemble the identity window for prompts.
 * Works with or without seed.md — falls back to world model context.
 */
export async function assembleIdentityWindow(
  conversationContext?: string
): Promise<string> {
  const [seed, narrative] = await Promise.all([
    readFileOrNull(path.join(IDENTITY_DIR, "seed.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "narrative.md")),
  ]);

  const parts: string[] = [];

  if (seed) {
    parts.push("=== IDENTITY SEED ===\n" + seed);
  }

  if (narrative) {
    parts.push("=== NARRATIVE ===\n" + narrative);
  }

  // If no seed, inject world model context as identity baseline
  if (!seed) {
    const worldIdentity = buildWorldModelIdentity();
    if (worldIdentity) {
      parts.push(worldIdentity);
    }
  }

  if (conversationContext) {
    const recallWindow = await buildRecallWindow(conversationContext);
    if (recallWindow.formattedContext) {
      parts.push(recallWindow.formattedContext);
    }
  }

  const recentObservations = await getRecentByType("observation", 3);
  if (recentObservations.length > 0) {
    const recentText = recentObservations
      .map((r) => `- [${r.metadata.timestamp}] ${r.text}`)
      .join("\n");
    parts.push("=== RECENT OBSERVATIONS ===\n" + recentText);
  }

  return parts.join("\n\n");
}

function buildSystemPrompt(
  identityWindow: string,
  deepSearchEnabled = true
): string {
  const deepSearchInstruction = deepSearchEnabled
    ? `If the user asks for a specific factual answer and you are not confident the answer is already in your current memory context, reply with ONLY [SEARCH: keyword-rich query]. Do not guess.`
    : "";

  return `You are Cecil — a personal assistant with persistent memory. You learn about the user through conversation and remember everything across sessions.

Your capabilities:
- You notice patterns in what the user says and does over time
- You track contradictions between what they say now vs. earlier
- You surface open loops — things they said they'd do but haven't followed up on
- You remember entities (people, projects, places) and how they connect
- You build an evolving understanding without requiring any setup or onboarding

How to behave:
- Be direct and useful. No filler, no sycophancy.
- Use your memory naturally — like a friend who just knows context. Don't recite facts back.
- If you notice a contradiction, surface it naturally: "Didn't you say X last time?"
- If an open loop seems relevant, mention it: "You mentioned wanting to do Y — did that happen?"
- When you learn something new about the user (name, role, preferences), absorb it naturally.
- If you don't know something, say so. Never fabricate details.

Evidence discipline:
- DIRECT_STATEMENT: The user told you directly. Highest confidence.
- OBSERVED_PATTERN: You detected this from repeated behavior/themes. Good evidence, state it as observation.
- PUBLIC_CORPUS: Extracted from public material (podcasts, etc). Useful but not private truth.
- INFERRED: Synthesized from multiple signals. Be transparent that it's inference.
- If no tier gives solid support, say so plainly.

${identityWindow}

${deepSearchInstruction}`.trim();
}

function buildDeepSearchSystemPrompt(
  identityWindow: string,
  searchResults: string
): string {
  return `You are Cecil — a personal assistant with persistent memory. You already searched your memory and found additional evidence.

Keep evidence discipline: direct statements are strongest, observed patterns are good evidence, public corpus is useful but not private truth, and inferred knowledge should be flagged as such.

${identityWindow}

=== DEEP SEARCH RESULTS ===
Use the following search results to answer the user's question accurately. If the answer is clearly present, rely on it. If the search results are incomplete or conflicting, say so plainly.

${searchResults}

Do not output another [SEARCH: ...] marker. Answer directly.`;
}

export async function buildChatPrompt(
  conversationContext: string,
  deepSearchEnabled = true
): Promise<string> {
  const identityWindow = await assembleIdentityWindow(conversationContext);
  return buildSystemPrompt(identityWindow, deepSearchEnabled);
}

export async function buildDeepSearchPrompt(
  conversationContext: string,
  searchResults: string
): Promise<string> {
  const identityWindow = await assembleIdentityWindow(conversationContext);
  return buildDeepSearchSystemPrompt(identityWindow, searchResults);
}

export async function chat(
  messages: Message[]
): Promise<{ response: string; sessionId: string; usedDeepSearch: boolean }> {
  const result = await generateResponse({
    messages,
    maxTokens: 2048,
    deepSearchEnabled: true,
    buildInitialPrompt: (conversationContext) =>
      buildChatPrompt(conversationContext, true),
    buildDeepSearchPrompt,
    noResultsResponse:
      "I checked my memory and couldn't find anything solid on that yet. Give me a little more context and I'll keep digging.",
  });

  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");

  return {
    response: result.response,
    sessionId,
    usedDeepSearch: result.usedDeepSearch,
  };
}
