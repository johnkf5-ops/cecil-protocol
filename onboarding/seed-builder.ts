import fs from "fs/promises";
import path from "path";
import { embed, embedBatch, initCollection } from "@/cecil/embedder";
import type { OnboardingAnswers } from "@/cecil/types";

const IDENTITY_DIR = path.join(process.cwd(), "identity");
const SEED_PATH = path.join(IDENTITY_DIR, "seed.md");
const NARRATIVE_PATH = path.join(IDENTITY_DIR, "narrative.md");
const DELTA_PATH = path.join(IDENTITY_DIR, "delta.md");

function buildSeedMarkdown(answers: OnboardingAnswers): string {
  return `# Identity Seed

> Captured during onboarding. This is immutable.

**Name:** ${answers.name}
**Age:** ${answers.age}
**Location:** ${answers.location}
**Occupation:** ${answers.occupation}
**Current Goal:** ${answers.currentGoal}
`;
}

export async function seedExists(): Promise<boolean> {
  try {
    await fs.access(SEED_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function buildSeed(answers: OnboardingAnswers): Promise<void> {
  // Don't overwrite an existing seed — it's immutable
  if (await seedExists()) {
    throw new Error("Seed already exists. Identity seed is immutable once set.");
  }

  await initCollection();

  // Write seed.md
  await fs.mkdir(IDENTITY_DIR, { recursive: true });
  const markdown = buildSeedMarkdown(answers);
  await fs.writeFile(SEED_PATH, markdown, "utf-8");

  // Initialize empty narrative and delta
  await fs.writeFile(
    NARRATIVE_PATH,
    "# Narrative\n\n> Who you are becoming. Updated by the observer over time.\n\n*No patterns detected yet.*\n",
    "utf-8"
  );
  await fs.writeFile(
    DELTA_PATH,
    "# Delta\n\n> The gap between who you said you are and what the patterns reveal.\n\n*Not enough data yet.*\n",
    "utf-8"
  );

  // Embed the full seed as one vector
  const now = new Date().toISOString();
  await embed(markdown, {
    type: "seed",
    timestamp: now,
    sourcePath: "identity/seed.md",
  });

  // Embed each answer individually for granular retrieval
  const items = [
    { text: `Name: ${answers.name}`, field: "name" },
    { text: `Age: ${answers.age}`, field: "age" },
    { text: `Location: ${answers.location}`, field: "location" },
    { text: `Occupation: ${answers.occupation}`, field: "occupation" },
    { text: `Current goal: ${answers.currentGoal}`, field: "currentGoal" },
  ];

  await embedBatch(
    items.map((item) => ({
      text: item.text,
      metadata: {
        type: "seed" as const,
        timestamp: now,
        sourcePath: "identity/seed.md",
      },
    }))
  );
}
