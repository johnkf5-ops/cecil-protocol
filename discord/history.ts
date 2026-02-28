import type { TextChannel } from "discord.js";
import type { Message } from "../cecil/types";
import { HISTORY_LIMIT } from "./config";

/**
 * Fetch last N messages from a Discord channel and format for LLM.
 * Bot's own messages -> assistant role.
 * Other bots -> user role with [AgentName] prefix.
 * Human messages -> user role, no prefix.
 */
export async function fetchHistory(
  channel: TextChannel,
  selfId: string
): Promise<Message[]> {
  const raw = await channel.messages.fetch({ limit: HISTORY_LIMIT });
  const sorted = [...raw.values()].reverse(); // oldest first

  return sorted.map((msg) => {
    if (msg.author.id === selfId) {
      return { role: "assistant" as const, content: msg.content };
    }

    const prefix = msg.author.bot
      ? `[${msg.author.displayName}] `
      : "";
    return { role: "user" as const, content: prefix + msg.content };
  });
}
