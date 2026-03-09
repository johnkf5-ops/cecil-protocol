/**
 * Thin wrapper for OpenAI-compatible chat completions.
 * Points at LM Studio by default.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = "qwen/qwen3.5-35b-a3b";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionOptions {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  timeoutMs?: number;
}

export function getModel(): string {
  return process.env.MODEL || DEFAULT_MODEL;
}

/**
 * Strip Qwen's thinking output. Handles both formats:
 * 1. <think>...</think> tags
 * 2. Plain text "Thinking Process:" blocks
 */
function stripThinking(text: string): string {
  // Strip <think>...</think> tags
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

  // Strip plain-text "Thinking Process:" blocks
  // These start with "Thinking Process:" and contain numbered/bulleted steps
  // The actual response follows after the thinking block
  const thinkingMatch = cleaned.match(/^Thinking Process:[\s\S]*?\n\n(?=[A-Z"'])/);
  if (thinkingMatch) {
    cleaned = cleaned.slice(thinkingMatch[0].length);
  } else if (cleaned.startsWith("Thinking Process:")) {
    // Fallback: find the last numbered item pattern, take everything after
    const lines = cleaned.split("\n");
    let lastThinkLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (
        line.match(/^\d+\./) ||
        line.match(/^\*\s/) ||
        line.match(/^\*\*/) ||
        line.match(/^-\s/) ||
        line === "" ||
        line.startsWith("Thinking Process")
      ) {
        lastThinkLine = i;
      }
    }
    // Take everything after the last thinking line
    const remainder = lines.slice(lastThinkLine + 1).join("\n").trim();
    if (remainder) {
      cleaned = remainder;
    }
  }

  return cleaned.trim();
}

/**
 * Sanitize message array for Qwen's strict template requirements:
 * 1. Must alternate user/assistant roles (merge consecutive same-role)
 * 2. Must end with a user message
 */
function sanitizeMessages(msgs: { role: "user" | "assistant"; content: string }[]): { role: "user" | "assistant"; content: string }[] {
  if (msgs.length === 0) return msgs;

  // Merge consecutive same-role messages
  const merged: { role: "user" | "assistant"; content: string }[] = [];
  for (const msg of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content += "\n\n" + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }

  // Ensure it ends with user
  while (merged.length && merged[merged.length - 1].role !== "user") {
    merged.pop();
  }

  return merged;
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
  const baseUrl = process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
  const model = getModel();

  const sanitized = sanitizeMessages(options.messages);

  const messages: ChatMessage[] = [
    { role: "system", content: options.system + "\n\nIMPORTANT: Do not include any thinking process, reasoning steps, or analysis in your response. Reply directly." },
    ...sanitized,
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";

  return stripThinking(raw);
}
