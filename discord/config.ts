import dotenv from "dotenv";
dotenv.config();

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
export const WAR_ROOM_ID = process.env.CHANNEL_ID || "";
export const GUILD_ID = process.env.GUILD_ID || "";
export const BOT_NAME = process.env.BOT_NAME || "cecil";
export const HISTORY_LIMIT = 20;
export const MAX_TOKENS = 500;
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
