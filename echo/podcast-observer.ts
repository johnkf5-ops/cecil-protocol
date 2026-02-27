import fs from "fs/promises";
import path from "path";
import { chatCompletion } from "./llm";
import { embed } from "./embedder";
import { getRecentByType } from "./retriever";

const IDENTITY_DIR = path.join(process.cwd(), "identity");
const OBSERVATIONS_DIR = path.join(process.cwd(), "memory", "observations");

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Run synthesis over all podcast content.
 * 3 LLM calls: pattern detection → narrative update → delta update.
 * Mirrors the observer.ts fullSynthesis pattern.
 */
export async function synthesizePodcasts(): Promise<{
  patternsWritten: boolean;
  narrativeUpdated: boolean;
  deltaUpdated: boolean;
}> {
  // Gather podcast vectors + existing identity
  const [podcastVectors, seed, narrative, delta] = await Promise.all([
    getRecentByType("podcast", 100),
    readFileOrNull(path.join(IDENTITY_DIR, "seed.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "narrative.md")),
    readFileOrNull(path.join(IDENTITY_DIR, "delta.md")),
  ]);

  if (!seed) {
    throw new Error("No seed.md found. Complete onboarding first.");
  }

  if (podcastVectors.length === 0) {
    throw new Error("No podcast vectors found in Qdrant. Run ingestion first.");
  }

  // Concatenate podcast content (truncate to avoid blowing context)
  const podcastContent = podcastVectors
    .map((v) => v.text)
    .join("\n---\n")
    .slice(0, 30000);

  console.log(`Synthesizing ${podcastVectors.length} podcast vectors...`);

  // --- LLM Call 1: Detect patterns across podcast content ---
  console.log("  [1/3] Detecting patterns...");
  const patterns = await chatCompletion({
    system: `You are an observer AI analyzing podcast transcripts from a person's own podcast. These are long-form, unfiltered conversations that reveal how they think, what they believe, their recurring themes, and their personality.

Analyze the content and detect:
- Core beliefs and worldview (what do they keep coming back to?)
- Communication style (how do they talk, argue, explain?)
- Recurring themes, interests, and obsessions
- Emotional patterns and what they get passionate about
- Contradictions or tensions in their thinking
- Key stories, references, or examples they use repeatedly
- Relationships and how they talk about people

Be specific. Cite evidence from the transcripts. Output a structured list of patterns.`,
    messages: [
      {
        role: "user",
        content: `Here is the person's identity seed:\n${seed}\n\nHere are excerpts from their podcast transcripts:\n${podcastContent}\n\nWhat patterns do you observe?`,
      },
    ],
    maxTokens: 3000,
  });

  // --- LLM Call 2: Update narrative with podcast insights ---
  console.log("  [2/3] Updating narrative...");
  const newNarrative = await chatCompletion({
    system: `You are updating a living narrative document about a person. You now have access to their podcast transcripts — hours of unfiltered conversation that reveal who they really are, beyond what they'd write in a profile.

Integrate the podcast insights into the existing narrative. The podcast content should deepen the picture, not replace it. Write in third person. Be direct and perceptive.

Output ONLY the updated narrative content in markdown. Start with "# Narrative" as the heading.`,
    messages: [
      {
        role: "user",
        content: `Identity seed:\n${seed}\n\nCurrent narrative:\n${narrative || "No narrative yet."}\n\nPatterns detected from podcast analysis:\n${patterns}\n\nWrite the updated narrative incorporating podcast insights.`,
      },
    ],
    maxTokens: 3000,
  });

  // --- LLM Call 3: Update delta with podcast insights ---
  console.log("  [3/3] Updating delta...");
  const newDelta = await chatCompletion({
    system: `You are computing the delta — the gap between who this person says they are and who they reveal themselves to be on their podcast. Podcast conversations are unfiltered — people say things they'd never write in a bio.

Compare the seed (stated identity) with what the podcast reveals. Look for:
- Things they're passionate about that they didn't mention in onboarding
- Beliefs or values that surface repeatedly in conversation but aren't in their stated identity
- Contradictions between how they present themselves and how they actually talk
- Hidden interests, concerns, or personality traits

Be specific. If there's no meaningful gap, say so.

Output ONLY the delta content in markdown. Start with "# Delta" as the heading.`,
    messages: [
      {
        role: "user",
        content: `Identity seed (what they stated):\n${seed}\n\nUpdated narrative:\n${newNarrative}\n\nPrevious delta:\n${delta || "No delta yet."}\n\nPodcast patterns:\n${patterns}\n\nCompute the updated delta.`,
      },
    ],
    maxTokens: 3000,
  });

  // Write results
  await fs.mkdir(OBSERVATIONS_DIR, { recursive: true });

  await Promise.all([
    fs.writeFile(path.join(IDENTITY_DIR, "narrative.md"), newNarrative, "utf-8"),
    fs.writeFile(path.join(IDENTITY_DIR, "delta.md"), newDelta, "utf-8"),
    fs.writeFile(
      path.join(OBSERVATIONS_DIR, "podcast-synthesis.md"),
      `# Podcast Synthesis\n\n**Generated:** ${new Date().toISOString()}\n**Vectors analyzed:** ${podcastVectors.length}\n\n## Patterns\n\n${patterns}\n`,
      "utf-8"
    ),
  ]);

  // Embed the synthesis observation
  await embed(patterns, {
    type: "observation",
    timestamp: new Date().toISOString(),
    sessionId: "podcast-synthesis",
    sourcePath: "memory/observations/podcast-synthesis.md",
  });

  console.log("Podcast synthesis complete.");
  return {
    patternsWritten: true,
    narrativeUpdated: true,
    deltaUpdated: true,
  };
}
