/**
 * Real-time correction handler.
 *
 * After every bot response, checks if the user corrected Marcus on a fact.
 * If so, immediately embeds the corrected fact into Qdrant as high-priority
 * and soft-retires conflicting old facts.
 */

import { chatCompletion } from "./llm";
import { embed, getQdrantClient, COLLECTION_NAME, embedText } from "./embedder";
import { recordMemoryWrite } from "./memory-store";
import type { Message } from "./types";

const MAX_TOKENS = 500;

const DETECTION_PROMPT = `You are a correction detector. Given a conversation exchange between a user and an assistant, determine if the user corrected the assistant about a factual claim.

A correction is when:
- The user says the assistant got something wrong ("No, actually...", "That's wrong", "I never said that", "I only have one...")
- The user provides the correct information to replace incorrect information
- The user clarifies a personal fact (name, age, family, location, preferences, etc.)

If a correction was made, extract the corrected fact(s) as clean, standalone statements.

Respond in JSON only. No markdown, no code blocks.

If correction detected:
{"corrected":true,"facts":[{"text":"<fact as a standalone sentence>","entities":["<person names>"],"category":"<personal|career|opinion|experience|preference>"}]}

If no correction:
{"corrected":false}

Examples:
User: "No, I have one daughter, not three. Her name is Emma."
→ {"corrected":true,"facts":[{"text":"The user has one daughter.","entities":["Emma"],"category":"personal"},{"text":"The user's daughter's name is Emma.","entities":["Emma"],"category":"personal"}]}

User: "What should we build next?"
→ {"corrected":false}`;

interface CorrectedFact {
  text: string;
  entities: string[];
  category: string;
}

interface DetectionResult {
  corrected: boolean;
  facts?: CorrectedFact[];
}

/**
 * Detect and handle corrections in the latest exchange.
 * Call this after every bot response (non-blocking).
 */
export async function handleCorrections(
  messages: Message[],
  sessionId: string,
  subjectName: string
): Promise<number> {
  // Need at least a user message and assistant response
  if (messages.length < 2) return 0;

  // Get the last user→assistant exchange
  const lastAssistant = findLast(messages, (m) => m.role === "assistant");
  const lastUser = findLast(messages, (m) => m.role === "user");

  if (!lastUser || !lastAssistant) return 0;

  // Quick pre-filter: skip if user message is too short or is a command
  const content = lastUser.content.trim();
  if (content.length < 10 || content.startsWith("!")) return 0;

  // Ask LLM to detect correction
  const detection = await detectCorrection(lastUser.content, lastAssistant.content);
  if (!detection.corrected || !detection.facts?.length) return 0;

  console.log(
    `[correction] Detected ${detection.facts.length} correction(s) — embedding immediately`
  );

  const now = new Date().toISOString();
  let embedded = 0;

  for (const fact of detection.facts) {
    try {
      // Embed the corrected fact with high priority
      const pointId = await embed(fact.text, {
        type: "fact",
        timestamp: now,
        sessionId,
        sourceType: "direct_correction",
        sourceId: `correction:${sessionId}:${embedded}`,
        entities: fact.entities.includes(subjectName)
          ? fact.entities
          : [subjectName, ...fact.entities],
        category: fact.category,
        qualityScore: 0.98,
        provenance: {
          writer: "correction-handler",
          correctionSource: "user_message",
          confidenceBand: "high",
          subjectName,
        },
      });

      // Record in structured memory
      await recordMemoryWrite({
        eventId: `correction:${sessionId}:${embedded}:${now}`,
        memoryKey: `fact:correction:${fact.text.slice(0, 60).replace(/\W+/g, "-")}`,
        memoryType: "fact",
        action: "upsert",
        text: fact.text,
        timestamp: now,
        sessionId,
        sourceType: "direct_correction",
        sourceId: `correction:${sessionId}:${embedded}`,
        qualityScore: 0.98,
        provenance: {
          writer: "correction-handler",
          correctionSource: "user_message",
          confidenceBand: "high",
          subjectName,
        },
      });

      console.log(`[correction] Embedded: "${fact.text}" (${pointId})`);

      // Search for and retire conflicting facts
      await retireConflicts(fact, now, sessionId, subjectName);

      embedded++;
    } catch (err) {
      console.error(`[correction] Failed to embed fact: "${fact.text}"`, err);
    }
  }

  return embedded;
}

async function detectCorrection(
  userMessage: string,
  assistantMessage: string
): Promise<DetectionResult> {
  try {
    const response = await chatCompletion({
      system: DETECTION_PROMPT,
      messages: [
        {
          role: "user",
          content: `Assistant said:\n${assistantMessage.slice(0, 1000)}\n\nUser replied:\n${userMessage.slice(0, 1000)}`,
        },
      ],
      maxTokens: MAX_TOKENS,
    });

    // Strip markdown code blocks if present
    const cleaned = response
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    return JSON.parse(cleaned) as DetectionResult;
  } catch (err) {
    console.error("[correction] Detection failed:", err);
    return { corrected: false };
  }
}

/**
 * Find old facts that conflict with the correction and soft-retire them.
 * Uses vector similarity to find semantically related facts, then marks
 * them with retired provenance.
 */
async function retireConflicts(
  correctedFact: CorrectedFact,
  timestamp: string,
  sessionId: string,
  subjectName: string
): Promise<void> {
  try {
    const client = getQdrantClient();
    const vector = await embedText(correctedFact.text);

    // Search for similar facts about the SAME subject only
    // Build entity filter: only match facts mentioning the subject or generic "the speaker"/"the user"
    const subjectVariants = [
      subjectName.toLowerCase(),
      "the speaker",
      "the user",
      "the host",
    ];

    const results = await client.search(COLLECTION_NAME, {
      vector,
      limit: 20,
      filter: {
        must: [{ key: "type", match: { value: "fact" } }],
        must_not: [
          { key: "sourceType", match: { value: "direct_correction" } },
        ],
      },
      score_threshold: 0.65,
    });

    if (results.length === 0) return;

    // Only retire facts about the subject — never touch facts about other people
    const toRetire = results.filter((r) => {
      const payload = r.payload as Record<string, unknown>;
      const text = ((payload.text as string) || "").toLowerCase();
      const entities = (payload.entities as string[]) || [];
      const entityMatch = entities.some((e) =>
        subjectVariants.includes(e.toLowerCase())
      );
      const textMatch = subjectVariants.some((v) => text.includes(v));
      return entityMatch || textMatch;
    });
    if (toRetire.length === 0) return;

    console.log(
      `[correction] Retiring ${toRetire.length} conflicting fact(s)`
    );

    for (const point of toRetire) {
      const payload = point.payload as Record<string, unknown>;
      const oldText = payload.text as string;

      // Update the point's provenance to mark it retired
      await client.setPayload(COLLECTION_NAME, {
        points: [point.id as string],
        payload: {
          provenance: {
            ...(payload.provenance as Record<string, unknown> | undefined),
            retired: true,
            retiredAt: timestamp,
            retiredBy: `correction:${sessionId}`,
            supersededBy: correctedFact.text,
          },
        },
      });

      // Record retirement event
      await recordMemoryWrite({
        eventId: `retire:${point.id}:${timestamp}`,
        memoryKey: `fact:retired:${point.id}`,
        memoryType: "fact",
        action: "retire",
        text: oldText,
        timestamp,
        sessionId,
        sourceType: "direct_correction",
        sourceId: point.id as string,
        qualityScore: 0,
        provenance: {
          writer: "correction-handler",
          reason: "superseded_by_user_correction",
          supersededBy: correctedFact.text,
        },
      });

      console.log(
        `[correction] Retired: "${oldText.slice(0, 80)}..." (${point.id})`
      );
    }
  } catch (err) {
    console.error("[correction] Conflict retirement failed:", err);
  }
}

function findLast<T>(arr: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return arr[i];
  }
  return undefined;
}
