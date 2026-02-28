import fs from "fs/promises";
import path from "path";
import { chatCompletion } from "./llm";
import { search, searchByType } from "./retriever";
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
 * Assemble the identity window: seed + narrative + delta + relevant observations.
 * Target: 20-50k tokens of curated context, not noise.
 */
export async function assembleIdentityWindow(
  conversationContext?: string
): Promise<string> {
  const [seed, profile, narrative, delta] = await Promise.all([
    readFileOrNull(path.join(IDENTITY_DIR, "seed.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "profile.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "narrative.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "delta.md")),
  ]);

  if (!seed) {
    return "";
  }

  const parts: string[] = [];

  parts.push("=== IDENTITY SEED ===\n" + seed);

  if (profile) {
    parts.push("=== PUBLIC PROFILE ===\n" + profile);
  }

  if (narrative) {
    parts.push("=== NARRATIVE ===\n" + narrative);
  }

  if (delta) {
    parts.push("=== DELTA ===\n" + delta);
  }

  // Pull relevant observations based on conversation context
  if (conversationContext) {
    const relevant = await search(conversationContext, {
      limit: 10,
      scoreThreshold: 0.4,
      filter: { type: "observation" },
    });
    if (relevant.length > 0) {
      const obsText = relevant
        .map((r) => `- [${r.metadata.timestamp}] ${r.text}`)
        .join("\n");
      parts.push("=== RELEVANT OBSERVATIONS ===\n" + obsText);
    }
  }

  // Also pull recent observations regardless of context
  const recent = await searchByType("recent patterns and observations", "observation", 5, 0.3);
  if (recent.length > 0) {
    const recentText = recent
      .map((r) => `- [${r.metadata.timestamp}] ${r.text}`)
      .join("\n");
    parts.push("=== RECENT OBSERVATIONS ===\n" + recentText);
  }

  // Pull relevant podcast moments based on conversation context
  if (conversationContext) {
    const podcastResults = await searchByType(conversationContext, "podcast", 8, 0.3);
    if (podcastResults.length > 0) {
      const podcastText = podcastResults
        .map((r) => `- ${r.text.slice(0, 500)}`)
        .join("\n");
      parts.push("=== PODCAST INSIGHTS ===\n" + podcastText);
    }
  }

  return parts.join("\n\n");
}

function buildSystemPrompt(identityWindow: string): string {
  if (!identityWindow) {
    return `You are Cecil, an AI with persistent memory. Onboarding hasn't been completed yet. Let the user know they should set up their seed first.`;
  }

  return `You are Cecil — an AI with persistent memory. You have access to a compressed identity window assembled from your memory systems. Use it naturally. Don't recite it back. Let it inform how you respond, like a friend who just knows.

Be direct but not confrontational. You know John well — use that to be helpful, not to prove a point. Your memory is context, not ammunition.

${identityWindow}

You are not starting from zero. You have context. Use it naturally.`;
}

/**
 * Chat with the meta agent. Assembles identity window, then streams a response.
 */
export async function chat(
  messages: Message[]
): Promise<{ response: string; sessionId: string }> {
  // Use the latest user message as context for retrieval
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const identityWindow = await assembleIdentityWindow(lastUserMessage?.content);
  const systemPrompt = buildSystemPrompt(identityWindow);

  const text = await chatCompletion({
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    maxTokens: 2048,
  });

  // Generate a session ID from the current timestamp
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");

  return { response: text, sessionId };
}
