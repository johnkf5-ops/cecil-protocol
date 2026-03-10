import { chatCompletion } from "./llm";

export interface ExtractedFact {
  fact: string;
  entities: string[];
  category: string;
}

interface ExtractedFactCandidate {
  fact?: unknown;
  entities?: unknown;
  category?: unknown;
}

const EXTRACTION_PROMPT = `You are a fact extraction module. Given a transcript excerpt from a podcast, extract specific factual statements about the people mentioned.

Focus on:
- Personal facts (family, relationships, age, location, background)
- Career facts (jobs, projects, companies, timelines)
- Opinions and beliefs (stated positions on topics)
- Experiences (events, milestones, achievements)
- Preferences (likes, dislikes, habits)

Rules:
- Each fact must be a single, self-contained sentence
- Include WHO the fact is about (use their name, not "he" or "she")
- Be specific — include dates, names, places when available
- Ignore filler, pleasantries, and off-topic tangents
- If no meaningful facts can be extracted, output NONE
- Output as a JSON array: [{"fact": "...", "entities": ["name1", "name2"], "category": "personal|career|opinion|experience|preference"}]

Output ONLY the JSON array. No other text.`;

function isExtractedFact(value: unknown): value is ExtractedFact {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as ExtractedFactCandidate;
  return (
    typeof candidate.fact === "string" &&
    candidate.fact.length > 0 &&
    Array.isArray(candidate.entities) &&
    candidate.entities.every((entity) => typeof entity === "string") &&
    typeof candidate.category === "string"
  );
}

function buildDiarizedExtractionPrompt(hostName: string): string {
  return `You are a fact extraction module. Given a diarized transcript excerpt, extract factual statements. Each line is prefixed with [HOST] or [GUEST].

CRITICAL RULE — speaker attribution:
- [HOST] lines are spoken by ${hostName}. Attribute these facts to "${hostName}".
- [GUEST] lines are spoken by the guest (their name is in the episode title). Attribute these facts to the guest BY NAME.
- NEVER attribute a [GUEST] statement to ${hostName}. NEVER attribute a [HOST] statement to the guest.

Extract facts from BOTH speakers. Focus on:
- Personal facts (family, relationships, age, location, background)
- Career facts (jobs, projects, companies, timelines)
- Opinions and beliefs (stated positions on topics)
- Experiences (events, milestones, achievements)
- Preferences (likes, dislikes, habits)

Rules:
- Each fact must be a single, self-contained sentence
- Use the person's actual name — "${hostName}" for [HOST] facts, the guest's real name for [GUEST] facts
- Never use "he", "she", "the host", "the guest", or "the speaker"
- Be specific — include dates, names, places when available
- Ignore filler, pleasantries, and off-topic tangents
- If no meaningful facts can be extracted, output NONE
- Output as a JSON array: [{"fact": "...", "entities": ["name1", "name2"], "category": "personal|career|opinion|experience|preference"}]

Output ONLY the JSON array. No other text.`;
}

/**
 * Extract facts from a transcript chunk using the LLM.
 * Returns parsed facts or empty array on failure.
 */
export async function extractFacts(
  chunkText: string,
  episodeTitle: string
): Promise<ExtractedFact[]> {
  const response = await chatCompletion({
    system: EXTRACTION_PROMPT,
    messages: [
      {
        role: "user",
        content: `Episode: ${episodeTitle}\n\nTranscript excerpt:\n${chunkText.slice(0, 4000)}`,
      },
    ],
    maxTokens: 2048,
  });

  try {
    let cleaned = response.trim();

    // Handle markdown code block wrapping
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    if (cleaned === "NONE" || cleaned === "[]") {
      return [];
    }

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isExtractedFact);
  } catch {
    console.warn(
      `[fact-extractor] Failed to parse LLM response for ${episodeTitle}: ${response.slice(0, 200)}`
    );
    return [];
  }
}

/**
 * Extract facts from a diarized transcript chunk (with [HOST]/[GUEST] prefixes).
 * Uses a host-aware prompt that attributes facts to the named host.
 */
export async function extractFactsDiarized(
  chunkText: string,
  episodeTitle: string,
  hostName: string = "the host"
): Promise<ExtractedFact[]> {
  const response = await chatCompletion({
    system: buildDiarizedExtractionPrompt(hostName),
    messages: [
      {
        role: "user",
        content: `Episode: ${episodeTitle}\n\nDiarized transcript excerpt:\n${chunkText.slice(0, 4000)}`,
      },
    ],
    maxTokens: 2048,
  });

  try {
    let cleaned = response.trim();

    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    if (cleaned === "NONE" || cleaned === "[]") {
      return [];
    }

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isExtractedFact);
  } catch {
    console.warn(
      `[fact-extractor] Failed to parse diarized LLM response for ${episodeTitle}: ${response.slice(0, 200)}`
    );
    return [];
  }
}
