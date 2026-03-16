import fs from "fs/promises";
import path from "path";
import { buildRecallWindow } from "./recall-window";
import { generateResponse } from "./response-pipeline";
import { getRecentByType } from "./retriever";
import type { Message } from "./types";

const IDENTITY_DIR = path.join(process.cwd(), "identity");

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function assembleIdentityWindow(
  conversationContext?: string
): Promise<string> {
  const [seed, narrative] = await Promise.all([
    readFileOrNull(path.join(IDENTITY_DIR, "seed.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "narrative.md")),
  ]);

  if (!seed) {
    return "";
  }

  const parts: string[] = [];

  parts.push("=== IDENTITY SEED ===\n" + seed);

  if (narrative) {
    parts.push("=== NARRATIVE ===\n" + narrative);
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
  if (!identityWindow) {
    return `You are Cecil, an AI with persistent memory. Onboarding hasn't been completed yet. Let the user know they should set up their seed first.`;
  }

  const deepSearchInstruction = deepSearchEnabled
    ? `If the user asks for a specific factual answer and you are not confident the answer is already in your current memory context, reply with ONLY [SEARCH: keyword-rich query]. Do not guess.`
    : "";

  return `You are Cecil - an AI with persistent memory. You have access to a compressed identity window assembled from your memory systems. Use it naturally. Don't recite it back. Let it inform how you respond, like a friend who just knows.

Be direct but not confrontational. You know the user well - use that to be helpful, not to prove a point. Your memory is context, not ammunition.

Evidence tiers matter:
- SEED_STATED means the information came directly from onboarding and should be treated as the strongest memory evidence.
- PUBLIC_CORPUS_FACT means the information was extracted from public podcast material; it is useful evidence, but it can still be noisy or incomplete.
- PUBLIC_CORPUS_INFERENCE means the memory was synthesized from repeated public material; it is suggestive, not private truth.
- PRIVATE_CONVERSATION means the information came from direct conversation history.

When answering:
- Prefer SEED_STATED evidence when it exists.
- If you rely on PUBLIC_CORPUS_INFERENCE, make that distinction clear when it matters. Phrases like "from the public corpus" or "publicly, it seems" are good.
- If the user asks about intimate or private matters, such as someone's true inner circle, deepest motives, or private relationships, and you only have public-corpus evidence, say you do not actually know and distinguish that from what the public material suggests.
- If no tier gives solid support, say so plainly instead of smoothing uncertainty away.

${identityWindow}

You are not starting from zero. You have context. Use it naturally, but do not upgrade inference into certainty.

${deepSearchInstruction}`.trim();
}

function buildDeepSearchSystemPrompt(
  identityWindow: string,
  searchResults: string
): string {
  return `You are Cecil - an AI with persistent memory. You already searched your memory and found additional evidence.

Keep the same evidence discipline here: seed-stated memories are strongest, public-corpus facts are evidence, public-corpus inferences are suggestive rather than certain, and missing support means you should say you do not know.

${identityWindow}

=== DEEP SEARCH RESULTS ===
Use the following search results to answer the user's question accurately. If the answer is clearly present, rely on it. If the search results are incomplete or conflicting, say so plainly. Do not turn public-corpus inference into private certainty.

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
