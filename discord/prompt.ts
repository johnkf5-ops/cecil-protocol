import fs from "fs/promises";
import path from "path";
import { assembleIdentityWindow } from "../cecil/meta";
import { MAX_TOKENS } from "./config";
import { MeetingState } from "./meeting";

const PERSONALITY_DIR = path.join(process.cwd(), "discord", "personality");

async function readPersonalityFile(name: string): Promise<string> {
  return fs.readFile(path.join(PERSONALITY_DIR, name), "utf-8");
}

/**
 * Build the full system prompt:
 * 1. SOUL.md — personality, voice, behavior
 * 2. Cecil identity window — seed + narrative + delta + relevant observations
 * 3. AGENTS.md — team roster, channel rules, handoff protocol
 * 4. Operational constraints (including deep search instruction)
 */
export async function buildSystemPrompt(
  conversationContext: string,
  deepSearchEnabled: boolean = true,
  meetingState?: MeetingState | null
): Promise<string> {
  const [soul, agents, identityWindow] = await Promise.all([
    readPersonalityFile("SOUL.md"),
    readPersonalityFile("AGENTS.md"),
    assembleIdentityWindow(conversationContext),
  ]);

  const parts: string[] = [];

  parts.push("=== PERSONALITY ===\n" + soul);

  if (identityWindow) {
    parts.push("=== MEMORY ===\n" + identityWindow);
  }

  parts.push("=== TEAM PROTOCOL ===\n" + agents);

  // Meeting mode injection
  if (meetingState?.active) {
    const meetingLines = [
      `YOU ARE IN MEETING MODE. You are the FACILITATOR right now, not the brain twin.`,
      `Topic: ${meetingState.topic}`,
      `Round: ${meetingState.round} of 3`,
      ``,
      `CRITICAL RULES:`,
      `- The system handles ALL agent routing. You MUST NOT tag, @mention, or address any agent by name.`,
      `- FORBIDDEN: Writing any agent name (Riley, Jules, Ava, Eli, Nadia, Kai) in your response. Never say "Riley nailed it" or "Nadia, draft the spec." Refer to input as "the intel," "the previous point," "the legal review," etc.`,
      `- FORBIDDEN: Using <@ syntax anywhere in your response. The system appends tags automatically.`,
      `- FORBIDDEN: Giving instructions to agents (e.g. "draft the spec" or "stand by to build"). You summarize and ask questions — the system handles routing.`,
      `- Synthesize the previous input (1-2 sentences), then ask a specific question for the next topic area.`,
      `- Ask specific questions, not just "thoughts?" — e.g. "What does the competitive landscape look like for recovery apps?"`,
      `- When wrapping up: summary format is DECIDED / OPEN QUESTIONS / NEXT STEPS / SPEC OUTLINE. Do NOT address anyone by name in the wrap-up.`,
    ];

    if (meetingState.closingRound) {
      meetingLines.push(
        `- CLOSING ROUND: Summarize the entire discussion. Write a spec outline. This gets posted for John's approval.`
      );
    } else if (meetingState.round >= 2) {
      meetingLines.push(`- Start converging. Focus on actionable decisions.`);
    }

    parts.push("=== MEETING MODE ===\n" + meetingLines.join("\n"));
  }

  const constraints = [
    `- Keep responses under 2000 characters (Discord limit).`,
    `- Do not output any thinking process, reasoning steps, or analysis.`,
    `- You are in a Discord group chat. Messages from other agents are prefixed with [AgentName].`,
    `- Messages from the human have no prefix.`,
    `- Be concise. Target ${MAX_TOKENS} tokens max.`,
  ];

  if (!meetingState?.active) {
    constraints.push(
      `- NEVER mention agent names (riley, jules, ava, eli, nadia, kai) in your responses. You are in brain twin mode — it's just you and John. Mentioning their names triggers them to respond and causes chaos.`
    );
  }

  if (deepSearchEnabled && !meetingState?.active) {
    constraints.push(
      `- DEEP SEARCH: If the user asks a specific factual question about their past, their podcasts, interviews, personal details, or anything you're not confident about from your memory above, output ONLY the text [SEARCH: your search query] as your entire response. Use a keyword-rich query that targets the specific information needed. Examples:`,
      `  - "Do I have a wife?" → [SEARCH: wife family partner spouse daughters personal life]`,
      `  - "What did I say about AI?" → [SEARCH: opinions AI artificial intelligence future]`,
      `  - "When did I start photography?" → [SEARCH: photography career beginning early start]`,
      `  Do NOT search for things you already know from your memory context above. Only search when you genuinely need more information.`
    );
  }

  parts.push("=== OPERATIONAL CONSTRAINTS ===\n" + constraints.join("\n"));

  return parts.join("\n\n");
}

/**
 * Build a second-pass prompt with deep search results injected.
 * Used after Cecil triggers a [SEARCH: ...] marker and we've
 * fetched results from Qdrant.
 */
export async function buildDeepSearchPrompt(
  conversationContext: string,
  searchResults: string
): Promise<string> {
  const [soul, agents, identityWindow] = await Promise.all([
    readPersonalityFile("SOUL.md"),
    readPersonalityFile("AGENTS.md"),
    assembleIdentityWindow(conversationContext),
  ]);

  const parts: string[] = [];

  parts.push("=== PERSONALITY ===\n" + soul);

  if (identityWindow) {
    parts.push("=== MEMORY ===\n" + identityWindow);
  }

  parts.push(
    "=== DEEP SEARCH RESULTS ===\n" +
      "You searched your memory and found the following. Use this to answer the user's question accurately. If the answer is clearly in these results, cite it naturally. If it's not here, say you don't have that information.\n\n" +
      searchResults
  );

  parts.push("=== TEAM PROTOCOL ===\n" + agents);

  parts.push(
    `=== OPERATIONAL CONSTRAINTS ===
- Keep responses under 2000 characters (Discord limit).
- Do not output any thinking process, reasoning steps, or analysis.
- Be concise. Target ${MAX_TOKENS} tokens max.
- You already searched your memory. Do NOT output another [SEARCH: ...] marker. Answer directly with what you found.`
  );

  return parts.join("\n\n");
}
