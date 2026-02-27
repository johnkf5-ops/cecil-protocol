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
    system: `You are an observer module analyzing ingested content (podcast transcripts). These are long-form, unfiltered conversations rich with signal.

Analyze the content and detect:
- Core themes and priorities (what keeps coming up?)
- Communication patterns (how are ideas expressed, argued, explained?)
- Recurring references, examples, or frameworks
- Contradictions or tensions within the content
- Evolution of thinking across different sessions
- Key relationships, influences, or dynamics

Be specific. Cite evidence from the transcripts. Output a structured list of patterns.`,
    messages: [
      {
        role: "user",
        content: `Here is the baseline seed:\n${seed}\n\nHere are excerpts from ingested transcripts:\n${podcastContent}\n\nWhat patterns do you observe?`,
      },
    ],
    maxTokens: 3000,
  });

  // --- LLM Call 2: Update narrative with podcast insights ---
  console.log("  [2/3] Updating narrative...");
  const newNarrative = await chatCompletion({
    system: `You are updating a living narrative document. You now have access to ingested content (transcripts) that provides deeper signal than the initial seed.

Integrate the new patterns into the existing narrative. The ingested content should deepen the understanding, not replace it. Be direct and specific.

Output ONLY the updated narrative content in markdown. Start with "# Narrative" as the heading.`,
    messages: [
      {
        role: "user",
        content: `Baseline seed:\n${seed}\n\nCurrent narrative:\n${narrative || "No narrative yet."}\n\nPatterns detected from ingested content:\n${patterns}\n\nWrite the updated narrative incorporating these insights.`,
      },
    ],
    maxTokens: 3000,
  });

  // --- LLM Call 3: Update delta with podcast insights ---
  console.log("  [3/3] Updating delta...");
  const newDelta = await chatCompletion({
    system: `You are computing the delta — the drift between the stated baseline and what the ingested content reveals. Ingested content is raw and unfiltered, often containing signal that the seed doesn't capture.

Compare the seed with what the ingested patterns reveal. Look for:
- Priorities or themes that appear in the data but not in the seed
- Contradictions between stated intent and observed patterns
- Nuances, complexities, or tensions the seed oversimplifies
- Emergent themes the baseline didn't anticipate

Be specific. If there's no meaningful drift, say so — don't fabricate gaps.

Output ONLY the delta content in markdown. Start with "# Delta" as the heading.`,
    messages: [
      {
        role: "user",
        content: `Baseline seed (stated):\n${seed}\n\nUpdated narrative:\n${newNarrative}\n\nPrevious delta:\n${delta || "No delta yet."}\n\nIngested content patterns:\n${patterns}\n\nCompute the updated delta.`,
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
