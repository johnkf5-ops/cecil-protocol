import type { TextChannel } from "discord.js";
import type { Message } from "../cecil/types";
import { HISTORY_LIMIT } from "./config";

/** Fewer history messages during meetings to avoid Qwen context overflow */
const MEETING_HISTORY_LIMIT = 30;

/**
 * Fetch last N messages from a Discord channel and format for LLM.
 * Bot's own messages -> assistant role.
 * Other bots -> user role with [AgentName] prefix.
 * Human messages -> user role, no prefix.
 */
export async function fetchHistory(
  channel: TextChannel,
  selfId: string,
  isMeeting: boolean = false
): Promise<Message[]> {
  const limit = isMeeting ? MEETING_HISTORY_LIMIT : HISTORY_LIMIT;
  const raw = await channel.messages.fetch({ limit });
  const sorted = [...raw.values()].reverse(); // oldest first

  const mapped = sorted.map((msg) => {
    if (msg.author.id === selfId) {
      return { role: "assistant" as const, content: msg.content };
    }

    const prefix = msg.author.bot
      ? `[${msg.author.displayName}] `
      : "";
    return { role: "user" as const, content: prefix + msg.content };
  });

  // Merge consecutive same-role messages to prevent Qwen Jinja template errors.
  // Discord split messages, fallbacks, and multi-agent responses can create
  // consecutive user or assistant messages which break Qwen's strict alternation.
  const merged: Message[] = [];
  for (const msg of mapped) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += "\n" + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}
