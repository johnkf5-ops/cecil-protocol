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

// Agent Discord bot IDs — derived from token first segment (base64 of bot ID)
// Used for real @mentions in meeting mode so mentionPatterns aren't needed
export const AGENT_IDS: Record<string, string> = {
  riley: "1476442097010741248",
  jules: "1476447016858157148",
  ava: "1476447624532857030",
  eli: "1476448204609556584",
  nadia: "1476449334596993106",
  kai: "1476449837179469894",
};
