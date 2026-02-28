import { chatCompletion } from "./llm";

export interface ExtractedFact {
  fact: string;
  entities: string[];
  category: string;
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

    // Validate structure
    return parsed.filter(
      (f: any) =>
        typeof f.fact === "string" &&
        f.fact.length > 0 &&
        Array.isArray(f.entities) &&
        typeof f.category === "string"
    );
  } catch {
    console.warn(
      `[fact-extractor] Failed to parse LLM response for ${episodeTitle}: ${response.slice(0, 200)}`
    );
    return [];
  }
}
