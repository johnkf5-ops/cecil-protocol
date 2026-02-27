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

export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
  const baseUrl = process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
  const model = getModel();

  const messages: ChatMessage[] = [
    { role: "system", content: options.system + "\n\nIMPORTANT: Do not include any thinking process, reasoning steps, or analysis in your response. Reply directly." },
    ...options.messages,
  ];

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";

  return stripThinking(raw);
}
