import fs from "fs/promises";
import path from "path";
import { assembleIdentityWindow } from "../cecil/meta";
import { MAX_TOKENS, AGENT_IDS } from "./config";
import { MeetingState } from "./meeting";

const PERSONALITY_DIR = path.join(process.cwd(), "discord", "personality");

async function readPersonalityFile(name: string): Promise<string> {
  return fs.readFile(path.join(PERSONALITY_DIR, name), "utf-8");
}

/**
 * Build the full system prompt:
 * 1. SOUL.md — personality, voice, behavior
 * 2. Cecil identity window — world model context + narrative + relevant observations
 * 3. AGENTS.md — team roster, channel rules, handoff protocol
 * 4. Meeting mode constraints (if active)
 * 5. Operational constraints (including deep search instruction)
 */
export async function buildSystemPrompt(
  conversationContext: string,
  deepSearchEnabled: boolean = true,
  meetingState?: MeetingState | null
): Promise<string> {
  const isMeeting = !!meetingState?.active;

  const promises: [Promise<string>, Promise<string | null>, Promise<string>] = [
    readPersonalityFile("SOUL.md"),
    isMeeting ? readPersonalityFile("AGENTS.md") : Promise.resolve(null),
    assembleIdentityWindow(conversationContext),
  ];
  const [soul, agents, identityWindow] = await Promise.all(promises);

  const parts: string[] = [];

  parts.push("=== PERSONALITY ===\n" + soul);

  if (identityWindow) {
    parts.push("=== MEMORY ===\n" + identityWindow);
  }

  if (agents) {
    parts.push("=== TEAM PROTOCOL ===\n" + agents);
  }

  // Meeting mode injection
  if (meetingState?.active) {
    const meetingLines = [
      `YOU ARE IN MEETING MODE. You are the FACILITATOR right now, not the brain twin.`,
      `Topic: ${meetingState.topic}`,
      `Round: ${meetingState.round} of 3`,
      ``,
      `CRITICAL RULES:`,
      `- The system handles ALL agent routing. You MUST NOT tag, @mention, or address any agent by name.`,
      `- FORBIDDEN: Writing any agent name (${Object.keys(AGENT_IDS).join(", ")}) in your response. Refer to input as "the intel," "the previous point," "the legal review," etc.`,
      `- FORBIDDEN: Using <@ syntax anywhere in your response. The system appends tags automatically.`,
      `- FORBIDDEN: Giving instructions to agents (e.g. "draft the spec" or "stand by to build"). You summarize and ask questions — the system handles routing.`,
      `- Synthesize the previous input (1-2 sentences), then ask a specific question for the next topic area.`,
      `- Ask specific questions, not just "thoughts?" — e.g. "What does the competitive landscape look like for recovery apps?"`,
      `- When wrapping up: summary format is DECIDED / OPEN QUESTIONS / NEXT STEPS / SPEC OUTLINE. Do NOT address anyone by name in the wrap-up.`,
    ];

    if (meetingState.closingRound) {
      meetingLines.push(
        `- CLOSING ROUND: Summarize the entire discussion. Write a spec outline. This gets posted for the user's approval.`
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
    `- ZERO FABRICATION RULE: You may ONLY state things that appear in your MEMORY section above or in the conversation history. If information is not there, DO NOT ANSWER — use [SEARCH:] or [WEBSEARCH:] instead. NEVER invent details, guess at answers, make up recommendations, or fill gaps with plausible-sounding fiction. This includes names, places, events, preferences, anecdotes, and real-world recommendations (restaurants, products, services). If you don't have the answer in memory, SEARCH for it.`,
  ];

  if (!meetingState?.active) {
    constraints.push(
      `- NEVER mention agent names (${Object.keys(AGENT_IDS).join(", ")}) in your responses. You are in brain twin mode — it's just you and the user. Mentioning their names triggers them to respond and causes chaos.`
    );
  }

  if (deepSearchEnabled && !meetingState?.active) {
    constraints.push(
      `- DEEP SEARCH (MANDATORY): When the user asks ANY question about their personal life, history, preferences, family, opinions, career details, or anything factual about themselves, you MUST output ONLY the text [SEARCH: your search query] as your ENTIRE response. Do not attempt to answer from memory. Do not guess. Just search. Examples:`,
      `  - "What's my favorite food?" → [SEARCH: favorite food preferences meals eating]`,
      `  - "Do I have a wife?" → [SEARCH: wife family partner spouse personal life]`,
      `  - "What did I say about AI?" → [SEARCH: opinions AI artificial intelligence future]`,
      `  - "When did I get into this?" → [SEARCH: origin story career beginning early start]`,
      `  - "What's my daughter's name?" → [SEARCH: daughter children kids family names]`,
      `  The ONLY time you skip the search is when the user is asking for your opinion, brainstorming, or having a general conversation that isn't about their personal facts.`,
      `- WEB SEARCH (MANDATORY): When the user asks about current events, news, public information, recommendations, prices, scores, weather, restaurants, reviews, or ANYTHING that requires real-world knowledge you don't have in your MEMORY section, output ONLY the text [WEBSEARCH: your search query] as your ENTIRE response. Do not guess. Do not make up recommendations. Just search. Examples:`,
      `  - "What's Bitcoin at right now?" → [WEBSEARCH: Bitcoin price today March 2026]`,
      `  - "What happened in the news today?" → [WEBSEARCH: top news today March 2026]`,
      `  - "Who won the game last night?" → [WEBSEARCH: NBA scores last night]`,
      `  - "Best restaurant in Las Vegas?" → [WEBSEARCH: best restaurants Las Vegas 2026]`,
      `  - "What's the weather?" → [WEBSEARCH: weather Las Vegas today]`,
      `  Use [SEARCH: ...] for personal/memory questions. Use [WEBSEARCH: ...] for world knowledge, recommendations, and current events.`
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
