import { Client, GatewayIntentBits, TextChannel, Events } from "discord.js";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { DISCORD_TOKEN, WAR_ROOM_ID, MAX_TOKENS, BOT_NAME } from "./config";
import { fetchHistory } from "./history";
import { buildSystemPrompt, buildDeepSearchPrompt } from "./prompt";
import { onResponse } from "./session";
import { chatCompletion } from "../cecil/llm";
import { initCollection } from "../cecil/embedder";
import { deepSearch } from "../cecil/deep-search";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Deep search toggle ---
let deepSearchEnabled = true;

// --- Message queue (simple mutex) ---
let processing = false;
const queue: (() => Promise<void>)[] = [];

async function drainQueue(): Promise<void> {
  if (processing || queue.length === 0) return;
  processing = true;
  const task = queue.shift()!;
  try {
    await task();
  } catch (err) {
    console.error("[bot] Error:", err);
  }
  processing = false;
  drainQueue();
}

// --- Bot events ---

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Online as ${c.user.tag}`);
  await initCollection();
  console.log("[bot] Qdrant collection ready");
});

// --- !clear command ---
const CLEAR_RE = /^!clear(?:\s+(\d+))?$/i;

async function handleClear(channel: TextChannel, count: number): Promise<void> {
  try {
    const fetched = await channel.bulkDelete(count, true);
    console.log(`[bot] Cleared ${fetched.size} messages from #${channel.name}`);
    const notice = await channel.send(`Cleared ${fetched.size} messages.`);
    setTimeout(() => notice.delete().catch(() => {}), 3000);
  } catch (err: any) {
    await channel.send(`Could not clear messages: ${err.message}`);
  }
}

// --- !readfile command ---
const READFILE_RE = /^!readfile\s+(.+)$/i;
const MAX_FILE_SIZE = 1800; // leave room for code block markers + filename

async function handleReadFile(channel: TextChannel, filePath: string): Promise<void> {
  try {
    const raw = await readFile(filePath.trim(), "utf-8");
    const ext = extname(filePath).replace(".", "") || "txt";
    if (raw.length <= MAX_FILE_SIZE) {
      await channel.send(`**${filePath.trim()}**\n\`\`\`${ext}\n${raw}\n\`\`\``);
    } else {
      // Split into chunks that fit Discord's 2000 char limit
      const lines = raw.split("\n");
      let chunk = "";
      let part = 1;
      for (const line of lines) {
        if (chunk.length + line.length + 1 > MAX_FILE_SIZE) {
          await channel.send(`**${filePath.trim()}** (part ${part})\n\`\`\`${ext}\n${chunk}\n\`\`\``);
          chunk = "";
          part++;
        }
        chunk += (chunk ? "\n" : "") + line;
      }
      if (chunk) {
        await channel.send(`**${filePath.trim()}** (part ${part})\n\`\`\`${ext}\n${chunk}\n\`\`\``);
      }
    }
    console.log(`[bot] Shared file: ${filePath.trim()} (${raw.length} chars)`);
  } catch (err: any) {
    await channel.send(`Could not read file: ${err.message}`);
  }
}

client.on(Events.MessageCreate, (message) => {
  // Ignore own messages
  if (message.author.id === client.user?.id) return;

  // Only respond in #war-room
  if (message.channelId !== WAR_ROOM_ID) return;

  // Handle !clear command
  const clearMatch = message.content.match(CLEAR_RE);
  if (clearMatch) {
    const count = Math.min(parseInt(clearMatch[1] || "100", 10), 100);
    const channel = message.channel as TextChannel;
    handleClear(channel, count);
    return;
  }

  // Handle !deepsearch toggle
  if (/^!deepsearch$/i.test(message.content)) {
    deepSearchEnabled = !deepSearchEnabled;
    const channel = message.channel as TextChannel;
    const status = deepSearchEnabled ? "ON" : "OFF";
    console.log(`[bot] Deep search toggled: ${status}`);
    const notice = channel.send(`Deep search: **${status}**`);
    return;
  }

  // Handle !readfile command (no LLM, just dump file)
  const readMatch = message.content.match(READFILE_RE);
  if (readMatch) {
    const channel = message.channel as TextChannel;
    handleReadFile(channel, readMatch[1]);
    return;
  }

  // Check for @mention or name mention
  const atMentioned = message.mentions.has(client.user!.id);
  const nameRe = new RegExp(`\\b${BOT_NAME}\\b`, "i");
  const nameMentioned = nameRe.test(message.content);
  if (!atMentioned && !nameMentioned) return;

  console.log(
    `[bot] Triggered by ${message.author.displayName}: ${message.content.slice(0, 80)}`
  );

  queue.push(async () => {
    const channel = message.channel as TextChannel;
    await channel.sendTyping();

    // Fetch conversation history
    const history = await fetchHistory(channel, client.user!.id);

    // Qwen requires the last message to be role:"user".
    // Trim any trailing assistant messages, then ensure the trigger is last.
    while (history.length && history[history.length - 1].role === "assistant") {
      history.pop();
    }
    const triggerContent = message.author.bot
      ? `[${message.author.displayName}] ${message.content}`
      : message.content;
    const last = history[history.length - 1];
    if (!last || last.content !== triggerContent) {
      history.push({ role: "user", content: triggerContent });
    }

    // Build system prompt with personality + Cecil memory + team protocol
    const userMessages = history.filter((m) => m.role === "user");
    const context =
      userMessages[userMessages.length - 1]?.content || message.content;
    const systemPrompt = await buildSystemPrompt(context);

    // Call LLM
    let response = await chatCompletion({
      system: systemPrompt,
      messages: history,
      maxTokens: MAX_TOKENS,
    });

    console.log(`[bot] LLM returned ${response.length} chars: ${response.slice(0, 120)}...`);

    // Check for deep search marker (only if enabled)
    const searchMatch = deepSearchEnabled
      ? response.match(/\[SEARCH:\s*(.+?)\]/)
      : null;
    if (searchMatch) {
      const searchQuery = searchMatch[1].trim();
      console.log(`[bot] Deep search triggered: "${searchQuery}"`);

      await channel.sendTyping();

      const searchResult = await deepSearch(searchQuery);
      console.log(`[bot] Deep search returned ${searchResult.results.length} results`);

      if (searchResult.results.length > 0) {
        const augmentedPrompt = await buildDeepSearchPrompt(
          context,
          searchResult.formattedContext
        );

        await channel.sendTyping();

        response = await chatCompletion({
          system: augmentedPrompt,
          messages: history,
          maxTokens: MAX_TOKENS,
        });

        console.log(`[bot] Post-search LLM returned ${response.length} chars`);
      } else {
        response =
          "I dug through everything I have and couldn't find anything specific on that. Can you give me more context?";
      }
    }

    // Strip any remaining search markers (safety net)
    response = response.replace(/\[SEARCH:\s*.+?\]/g, "").trim();

    if (!response) {
      console.error("[bot] Empty response from LLM — skipping send");
      return;
    }

    // Send to Discord (respect 2000 char limit)
    await channel.send(response.slice(0, 2000));

    // Feed into Cecil observer pipeline (background, non-blocking)
    onResponse([...history, { role: "assistant", content: response }]);

    console.log(`[bot] Replied (${response.length} chars)`);
  });

  drainQueue();
});

// --- Start ---

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("[bot] Login failed:", err);
  process.exit(1);
});
