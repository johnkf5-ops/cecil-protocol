import dotenv from "dotenv";
dotenv.config();

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
export const WAR_ROOM_ID = process.env.CHANNEL_ID || "";
export const SPECS_CHANNEL_ID = process.env.SPECS_CHANNEL_ID || "";
export const GUILD_ID = process.env.GUILD_ID || "";
export const BOT_NAME = process.env.BOT_NAME || "cecil";
export const HISTORY_LIMIT = 40;
export const MAX_TOKENS = 1000;
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const MEETING_DELAY_MS = 10000; // 10s pause between meeting turns

// Agent Discord bot IDs — parsed from DISCORD_AGENTS env var
// Format: JSON object {"agent_name": "discord_bot_id", ...}
// Used for real @mentions in meeting mode so mentionPatterns aren't needed
export const AGENT_IDS: Record<string, string> = process.env.DISCORD_AGENTS
  ? JSON.parse(process.env.DISCORD_AGENTS)
  : {};

// Meeting agent order — comma-separated agent names from DISCORD_AGENTS keys
// These agents are called in order during meeting rounds
export const MEETING_AGENT_ORDER: string[] = process.env.MEETING_AGENT_ORDER
  ? process.env.MEETING_AGENT_ORDER.split(",").map((s) => s.trim()).filter(Boolean)
  : Object.keys(AGENT_IDS);

// Spec agent — receives !approve handoff in #specs
export const SPEC_AGENT = process.env.SPEC_AGENT || "";

// Build agent — tagged by the spec agent relay after spec is written
export const BUILD_AGENT = process.env.BUILD_AGENT || "";
