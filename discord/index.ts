import { Client, GatewayIntentBits, TextChannel, Events } from "discord.js";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { DISCORD_TOKEN, WAR_ROOM_ID, SPECS_CHANNEL_ID, MAX_TOKENS, BOT_NAME, MEETING_DELAY_MS, AGENT_IDS, MEETING_AGENT_ORDER, SPEC_AGENT } from "./config";
import { fetchHistory } from "./history";
import { buildSystemPrompt, buildDeepSearchPrompt } from "./prompt";
import { onResponse } from "./session";
import { chatCompletion } from "../cecil/llm";
import { initCollection } from "../cecil/embedder";
import { deepSearch } from "../cecil/deep-search";
import { webSearch } from "../cecil/web-search";
import {
  startMeeting,
  endMeeting,
  getMeeting,
  advanceAgent,
  firstAgent,
  currentAgent,
  nextAgent,
  setClosingRound,
} from "./meeting";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Deep search toggle ---
let deepSearchEnabled = true;

// --- #specs relay (marker-based) ---
// Agents write [TAG: name] when they want to hand off to another agent.
// Cecil detects markers, waits 30s for segments to finish, then posts real @tags.
// OpenClaw strips <@id> but not [TAG: name], so markers survive in agent output.
const TAG_MARKER_RE = /\[TAG:\s*(\w+)\]/gi;
let specsRelayTimeout: ReturnType<typeof setTimeout> | null = null;
const specsRelayPending: Set<string> = new Set(); // agent IDs to tag

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clearSpecsRelay(): void {
  if (specsRelayTimeout) { clearTimeout(specsRelayTimeout); specsRelayTimeout = null; }
  specsRelayPending.clear();
}

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
  } catch (err: unknown) {
    await channel.send(`Could not clear messages: ${getErrorMessage(err)}`);
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
  } catch (err: unknown) {
    await channel.send(`Could not read file: ${getErrorMessage(err)}`);
  }
}

// --- Core LLM response handler ---
async function handleLLMResponse(
  channel: TextChannel,
  triggerContent: string,
  isBot: boolean,
  displayName: string,
  agentTag?: { name: string; id: string } | null
): Promise<void> {
  await channel.sendTyping();

  const meeting = getMeeting();

  // Fetch conversation history (fewer messages during meetings to avoid context overflow)
  const history = await fetchHistory(channel, client.user!.id, !!meeting?.active);

  // Qwen requires the last message to be role:"user".
  // Trim any trailing assistant messages, then ensure the trigger is last.
  while (history.length && history[history.length - 1].role === "assistant") {
    history.pop();
  }
  const formattedTrigger = isBot
    ? `[${displayName}] ${triggerContent}`
    : triggerContent;
  const last = history[history.length - 1];
  if (!last || !last.content.includes(formattedTrigger)) {
    history.push({ role: "user", content: formattedTrigger });
  }

  // Re-merge to guarantee strict user/assistant alternation for Qwen.
  // The trigger push above can create consecutive user messages.
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].role === history[i - 1].role) {
      history[i - 1].content += "\n" + history[i].content;
      history.splice(i, 1);
    }
  }

  // Build system prompt with personality + Cecil memory + team protocol + meeting state
  const userMessages = history.filter((m) => m.role === "user");
  const context =
    userMessages[userMessages.length - 1]?.content || triggerContent;
  const systemPrompt = await buildSystemPrompt(context, deepSearchEnabled, meeting);

  console.log(`[bot] System prompt: ${systemPrompt.length} chars, history: ${history.length} msgs (${history.reduce((s, m) => s + m.content.length, 0)} chars)`);

  // Call LLM
  let response = await chatCompletion({
    system: systemPrompt,
    messages: history,
    maxTokens: MAX_TOKENS,
  });

  console.log(`[bot] LLM returned ${response.length} chars: ${response.slice(0, 120)}...`);

  // Check for deep search marker (only if enabled and no active meeting)
  const searchMatch = (deepSearchEnabled && !meeting?.active)
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

  // Check for web search marker
  const webSearchMatch = (!meeting?.active)
    ? response.match(/\[WEBSEARCH:\s*(.+?)\]/)
    : null;
  if (webSearchMatch) {
    const webQuery = webSearchMatch[1].trim();
    console.log(`[bot] Web search triggered: "${webQuery}"`);

    await channel.sendTyping();

    const webResult = await webSearch(webQuery);
    console.log(`[bot] Web search returned ${webResult.results.length} results`);

    if (webResult.results.length > 0) {
      const webPrompt = await buildDeepSearchPrompt(
        context,
        `=== WEB SEARCH RESULTS ===\nQuery: "${webQuery}"\n\n${webResult.formattedContext}`
      );

      await channel.sendTyping();

      response = await chatCompletion({
        system: webPrompt,
        messages: history,
        maxTokens: MAX_TOKENS,
      });

      console.log(`[bot] Post-web-search LLM returned ${response.length} chars`);
    } else {
      response = "Web search came back empty. Try rephrasing or give me more context.";
    }
  }

  // Strip any remaining search markers (safety net)
  response = response.replace(/\[SEARCH:\s*.+?\]/g, "").replace(/\[WEBSEARCH:\s*.+?\]/g, "").trim();

  // Strip any LLM-generated @mentions (code handles all tagging)
  response = response.replace(/<@!?\d+>/g, "").replace(/<@[^>]*>/g, "").trim();

  if (!response) {
    console.error("[bot] Empty response from LLM — skipping send");
    return;
  }

  // Append agent tag if provided (code-based routing — LLM never tags agents)
  if (agentTag) {
    response += `\n\n<@${agentTag.id}>`;
    console.log(`[bot] Meeting: appended tag for ${agentTag.name} (<@${agentTag.id}>)`);
  }

  // Send to Discord (respect 2000 char limit)
  await channel.send(response.slice(0, 2000));

  // Feed into Cecil observer pipeline (background, non-blocking)
  onResponse([...history, { role: "assistant", content: response }]);

  console.log(`[bot] Replied (${response.length} chars)`);
}

// --- Command regexes ---
const MEET_RE = /^!meet\s+(.+)$/i;
const WRAP_RE = /^!wrap\b/i;
const STOP_RE = /^!stop\b/i;
const STATUS_RE = /^!status\b/i;
const APPROVE_RE = /!approve\b/i;

client.on(Events.MessageCreate, (message) => {
  // Ignore own messages
  if (message.author.id === client.user?.id) return;

  // --- #specs relay: detect [TAG: name] markers, auto-tag after 30s debounce ---
  if (
    message.channelId === SPECS_CHANNEL_ID &&
    message.author.bot &&
    message.author.id !== client.user?.id
  ) {
    // Scan for [TAG: name] markers
    let match: RegExpExecArray | null;
    const tagRe = new RegExp(TAG_MARKER_RE.source, TAG_MARKER_RE.flags);
    while ((match = tagRe.exec(message.content)) !== null) {
      const name = match[1].toLowerCase();
      const id = AGENT_IDS[name];
      if (id) specsRelayPending.add(id);
    }

    if (specsRelayPending.size > 0) {
      // Reset 30s debounce on every message (waits for segments to finish)
      if (specsRelayTimeout) clearTimeout(specsRelayTimeout);
      const tagsToSend = new Set(specsRelayPending);
      specsRelayTimeout = setTimeout(async () => {
        try {
          const specsChannel = await client.channels.fetch(SPECS_CHANNEL_ID) as TextChannel;
          const tags = [...tagsToSend].map(id => `<@${id}>`).join(" ");
          await specsChannel.send(tags);
          const names = [...tagsToSend].map(id =>
            Object.entries(AGENT_IDS).find(([, v]) => v === id)?.[0] || id
          );
          console.log(`[bot] #specs relay: tagged ${names.join(", ")} via [TAG] markers`);
        } catch (err) {
          console.error("[bot] #specs relay failed:", err);
        }
        clearSpecsRelay();
      }, 30000);
      console.log(`[bot] #specs relay: [TAG] marker found — ${specsRelayPending.size} agent(s) queued, 30s timer reset`);
    }
    return;
  }

  // --- !clear in #specs (before war-room filter) ---
  if (message.channelId === SPECS_CHANNEL_ID && !message.author.bot) {
    const specsClearMatch = message.content.match(CLEAR_RE);
    if (specsClearMatch) {
      const count = Math.min(parseInt(specsClearMatch[1] || "100", 10), 100);
      handleClear(message.channel as TextChannel, count);
    }
    return;
  }

  const channel = message.channel as TextChannel;
  const meeting = getMeeting();

  // Meeting commands only work in #war-room
  const inWarRoom = message.channelId === WAR_ROOM_ID;

  // --- !help command (always available) ---
  if (/^!help\b/i.test(message.content)) {
    const helpText = [
      "**Commands**",
      "`!meet <topic>` — Start a meeting on a topic",
      "`!wrap` — Trigger closing round early",
      "`!stop` — Hard stop the meeting immediately",
      "`!status` — Show current meeting state",
      "`!approve` — Approve and hand off to the spec agent in #specs",
      "`!deepsearch` — Toggle deep search on/off (currently **" + (deepSearchEnabled ? "ON" : "OFF") + "**)",
      "`!clear [n]` — Delete last n messages (default 100)",
      "`!readfile <path>` — Share a file's contents in chat",
      "`!help` — This message",
      "",
      "**Meeting Flow**",
      MEETING_AGENT_ORDER.join(" → ") + " — 3 rounds, then wrap-up.",
      "After wrap-up, `!approve` hands off to the spec agent in #specs.",
    ].join("\n");
    channel.send(helpText);
    return;
  }

  // --- !clear command (always available) ---
  const clearMatch = message.content.match(CLEAR_RE);
  if (clearMatch) {
    const count = Math.min(parseInt(clearMatch[1] || "100", 10), 100);
    handleClear(channel, count);
    return;
  }

  // --- !deepsearch toggle (always available) ---
  if (/^!deepsearch$/i.test(message.content)) {
    deepSearchEnabled = !deepSearchEnabled;
    const status = deepSearchEnabled ? "ON" : "OFF";
    console.log(`[bot] Deep search toggled: ${status}`);
    channel.send(`Deep search: **${status}**`);
    return;
  }

  // --- !readfile command (always available) ---
  const readMatch = message.content.match(READFILE_RE);
  if (readMatch) {
    handleReadFile(channel, readMatch[1]);
    return;
  }

  // --- !meet <topic> (start a meeting, #war-room only) ---
  const meetMatch = message.content.match(MEET_RE);
  if (meetMatch && !message.author.bot && inWarRoom) {
    if (meeting?.active) {
      channel.send("Meeting already in progress. Use `!stop` to end it first.");
      return;
    }
    const topic = meetMatch[1].trim();
    startMeeting(topic);
    const first = firstAgent();
    console.log(`[bot] Meeting started: "${topic}" — first agent: ${first.name}`);

    queue.push(async () => {
      await handleLLMResponse(channel, `!meet ${topic}`, false, message.author.displayName, first);
    });
    drainQueue();
    return;
  }

  // --- !wrap (trigger closing round early, #war-room only) ---
  if (WRAP_RE.test(message.content) && !message.author.bot && inWarRoom) {
    if (!meeting?.active) {
      channel.send("No meeting in progress.");
      return;
    }
    setClosingRound();
    console.log("[bot] Meeting: closing round triggered by !wrap");

    queue.push(async () => {
      await handleLLMResponse(channel, "!wrap — the user wants to wrap up. Post your summary and spec outline now.", false, message.author.displayName, null);
    });
    drainQueue();
    return;
  }

  // --- !stop (hard stop, #war-room only) ---
  if (STOP_RE.test(message.content) && !message.author.bot && inWarRoom) {
    if (meeting?.active) {
      endMeeting();
      console.log("[bot] Meeting stopped by !stop");
      channel.send("Meeting stopped.");
    } else {
      channel.send("No meeting in progress.");
    }
    return;
  }

  // --- !status (show meeting state, #war-room only) ---
  if (STATUS_RE.test(message.content) && !message.author.bot && inWarRoom) {
    if (!meeting?.active) {
      channel.send("No meeting in progress. Brain twin mode active.");
      return;
    }
    const agent = currentAgent();
    const statusMsg = [
      `**Meeting Status**`,
      `Topic: ${meeting.topic}`,
      `Round: ${meeting.round} of 3`,
      `Current agent: ${agent ? agent.name : "none"}`,
      `Closing: ${meeting.closingRound ? "yes" : "no"}`,
      `Awaiting approval: ${meeting.awaitingApproval ? "yes" : "no"}`,
    ].join("\n");
    channel.send(statusMsg);
    return;
  }

  // --- !approve (hand off to spec agent in #specs, #war-room only) ---
  if (APPROVE_RE.test(message.content) && !message.author.bot && inWarRoom) {
    console.log("[bot] !approve triggered");
    if (!meeting?.active) {
      channel.send("No meeting in progress.");
      return;
    }

    const topic = meeting.topic;
    console.log("[bot] Spec approved — handing off to spec agent");

    // Post handoff to #specs tagging spec agent
    queue.push(async () => {
      try {
        if (!SPECS_CHANNEL_ID) {
          console.error("[bot] SPECS_CHANNEL_ID not set — cannot hand off");
          await channel.send("Error: #specs channel not configured.");
          return;
        }

        const specsChannel = await client.channels.fetch(SPECS_CHANNEL_ID) as TextChannel;

        // Build a brief meeting summary for the spec agent's context
        await channel.sendTyping();
        const history = await fetchHistory(channel, client.user!.id, true);
        while (history.length && history[history.length - 1].role === "assistant") {
          history.pop();
        }
        history.push({ role: "user", content: `Approved. Write a 3-4 bullet summary of what the team decided during the meeting on "${topic}". Just the key decisions and requirements — the spec agent will use this to write the full spec.` });

        // Re-merge to guarantee alternation
        for (let i = history.length - 1; i > 0; i--) {
          if (history[i].role === history[i - 1].role) {
            history[i - 1].content += "\n" + history[i].content;
            history.splice(i, 1);
          }
        }

        const userMessages = history.filter((m) => m.role === "user");
        const context = userMessages[userMessages.length - 1]?.content || "";
        const systemPrompt = await buildSystemPrompt(context, false, meeting);

        let summary = await chatCompletion({
          system: systemPrompt,
          messages: history,
          maxTokens: MAX_TOKENS,
        });
        summary = summary.replace(/\[SEARCH:\s*.+?\]/g, "").trim();
        summary = summary.replace(/<@!?\d+>/g, "").replace(/<@[^>]*>/g, "").trim();

        const specAgentId = AGENT_IDS[SPEC_AGENT];
        const specTag = specAgentId ? `<@${specAgentId}>` : "";
        const handoff = summary
          ? `**APPROVED — ${topic}**\n\n${summary}\n\n${specTag} — write the full spec.`
          : `**APPROVED — ${topic}**\n\nWrite the full spec based on the war-room discussion.\n\n${specTag}`;

        await specsChannel.send(handoff.slice(0, 2000));
        console.log(`[bot] Handoff posted to #specs tagging ${SPEC_AGENT} (${handoff.length} chars)`);

        await channel.send(`Meeting closed — handed off to ${SPEC_AGENT} in #specs.`);

        // #specs relay is always active — no need to arm it
      } catch (err) {
        console.error("[bot] !approve handoff failed:", err);
        // Fallback: post minimal handoff
        try {
          const specsChannel = await client.channels.fetch(SPECS_CHANNEL_ID) as TextChannel;
          const fallbackSpecId = AGENT_IDS[SPEC_AGENT];
          const fallbackTag = fallbackSpecId ? `<@${fallbackSpecId}>` : "";
          await specsChannel.send(`**APPROVED — ${topic}**\n\nWrite the full spec based on the war-room discussion.\n\n${fallbackTag}`);
          await channel.send(`Meeting closed — handed off to ${SPEC_AGENT} in #specs.`);
          // #specs relay is always active — no need to arm it
        } catch {
          await channel.send("Meeting closed. Could not post to #specs — hand off manually.");
        }
      }

      // Meeting ALWAYS ends on !approve
      endMeeting();
      console.log("[bot] Meeting ended after approval");
    });
    drainQueue();
    return;
  }

  // --- During active meeting: respond to ALL bot messages in #war-room (agent responses) ---
  if (meeting?.active && message.author.bot && inWarRoom) {
    console.log(
      `[bot] Meeting: agent response from ${message.author.displayName}: ${message.content.slice(0, 80)}`
    );

    queue.push(async () => {
      // Deliberate pause — prevents cascade, gives the user time to !stop/!wrap
      console.log(`[bot] Meeting: waiting ${MEETING_DELAY_MS}ms before responding...`);
      await new Promise((r) => setTimeout(r, MEETING_DELAY_MS));

      // Check if meeting was stopped during the delay
      const current = getMeeting();
      if (!current?.active) {
        console.log("[bot] Meeting ended during delay — skipping response");
        return;
      }

      // Only process messages from the agent we're currently expecting (split message guard)
      const expected = currentAgent();
      if (expected && message.author.id !== expected.id) {
        console.log(`[bot] Meeting: ignoring split/extra message from ${message.author.displayName} (waiting for ${expected.name})`);
        return;
      }

      // Peek at next agent (don't advance yet — advance only after success)
      const next = nextAgent();

      if (!next) {
        console.log("[bot] Meeting: closing round — no more agent tags");
      } else {
        console.log(`[bot] Meeting: next up: ${next.name} (round ${current.round})`);
      }

      try {
        await handleLLMResponse(channel, message.content, true, message.author.displayName, next);
        // Advance state only after successful send
        advanceAgent();
      } catch (err) {
        console.error("[bot] Meeting: LLM failed, sending fallback:", err);
        // Send fallback to keep meeting moving
        if (next) {
          await channel.send(`Let's keep moving — <@${next.id}>`);
        }
        advanceAgent();
      }
    });
    drainQueue();
    return;
  }

  // --- Outside of meetings: ignore ALL bot messages (prevents loops) ---
  if (!meeting?.active && message.author.bot) return;

  // --- Default: respond to @mention or name mention (brain twin mode + meeting human messages) ---
  const atMentioned = message.mentions.has(client.user!.id);
  const nameRe = new RegExp(`\\b${BOT_NAME}\\b`, "i");
  const nameMentioned = nameRe.test(message.content);

  // During active meeting, also respond to human messages (no mention needed)
  const shouldRespond = atMentioned || nameMentioned || (meeting?.active && !message.author.bot);

  if (!shouldRespond) return;

  console.log(
    `[bot] Triggered by ${message.author.displayName}: ${message.content.slice(0, 80)}`
  );

  queue.push(async () => {
    await handleLLMResponse(channel, message.content, message.author.bot, message.author.displayName);
  });

  drainQueue();
});

// --- Start ---

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("[bot] Login failed:", err);
  process.exit(1);
});
