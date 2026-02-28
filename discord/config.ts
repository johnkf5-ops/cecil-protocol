import dotenv from "dotenv";
dotenv.config();

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
export const WAR_ROOM_ID = "1477326548163104958"; // #cecil channel
export const GUILD_ID = "1476420400538845194";
export const HISTORY_LIMIT = 20;
export const MAX_TOKENS = 500;
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
