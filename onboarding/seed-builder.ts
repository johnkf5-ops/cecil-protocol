import fs from "fs/promises";
import path from "path";
import {
  deletePointsByFilter,
  embed,
  embedBatch,
  initCollection,
} from "@/cecil/embedder";
import { recordMemoryWrite } from "@/cecil/memory-store";
import type { OnboardingAnswers } from "@/cecil/types";

const IDENTITY_DIR = path.join(process.cwd(), "identity");
const MEMORY_DIR = path.join(process.cwd(), "memory");
const OBSERVATIONS_DIR = path.join(MEMORY_DIR, "observations");
const SEED_PATH = path.join(IDENTITY_DIR, "seed.md");
const NARRATIVE_PATH = path.join(IDENTITY_DIR, "narrative.md");
const DELTA_PATH = path.join(IDENTITY_DIR, "delta.md");
const SEED_PROFILE_SOURCE_PATH = "memory/observations/seed-profile.md";
const SEED_PROFILE_SOURCE_ID = "seed-profile";

interface SeedProfileObservation {
  field: keyof OnboardingAnswers;
  label: string;
  text: string;
  qualityScore: number;
}

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

function parseSeedMarkdown(markdown: string): OnboardingAnswers | null {
  const fields = {
    name: markdown.match(/\*\*Name:\*\*\s*(.+)/i)?.[1]?.trim(),
    age: markdown.match(/\*\*Age:\*\*\s*(.+)/i)?.[1]?.trim(),
    location: markdown.match(/\*\*Location:\*\*\s*(.+)/i)?.[1]?.trim(),
    occupation: markdown.match(/\*\*Occupation:\*\*\s*(.+)/i)?.[1]?.trim(),
    currentGoal: markdown.match(/\*\*Current Goal:\*\*\s*(.+)/i)?.[1]?.trim(),
  };

  if (Object.values(fields).some((value) => !value)) {
    return null;
  }

  return fields as OnboardingAnswers;
}

function buildSeedProfileObservations(
  answers: OnboardingAnswers
): SeedProfileObservation[] {
  const subjectName = answers.name.trim();

  return [
    {
      field: "name",
      label: "Name",
      text: `The primary subject is ${subjectName}.`,
      qualityScore: 0.95,
    },
    {
      field: "age",
      label: "Age",
      text: `${subjectName} is ${answers.age.trim()} years old.`,
      qualityScore: 0.95,
    },
    {
      field: "location",
      label: "Location",
      text: `${subjectName} lives in ${answers.location.trim()}.`,
      qualityScore: 0.99,
    },
    {
      field: "occupation",
      label: "Occupation",
      text: `${subjectName} works as ${answers.occupation.trim()}.`,
      qualityScore: 0.98,
    },
    {
      field: "currentGoal",
      label: "Current Goal",
      text: `${subjectName}'s current goal is ${answers.currentGoal.trim()}.`,
      qualityScore: 0.99,
    },
  ];
}

export async function seedExists(): Promise<boolean> {
  try {
    await fs.access(SEED_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function syncSeedProfileMemories(
  seedSource?: string | OnboardingAnswers
): Promise<number> {
  const answers =
    typeof seedSource === "string"
      ? parseSeedMarkdown(seedSource)
      : seedSource ?? parseSeedMarkdown(await fs.readFile(SEED_PATH, "utf-8"));

  if (!answers) {
    return 0;
  }

  await initCollection();

  const observations = buildSeedProfileObservations(answers);
  const now = new Date().toISOString();

  await fs.mkdir(OBSERVATIONS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OBSERVATIONS_DIR, "seed-profile.md"),
    [
      "# Seed Profile",
      "",
      `**Generated:** ${now}`,
      `**Subject:** ${answers.name}`,
      "",
      ...observations.flatMap((item) => [
        `## ${item.label}`,
        "",
        item.text,
        "",
      ]),
    ].join("\n"),
    "utf-8"
  );

  await deletePointsByFilter({
    type: "observation",
    sourceEpisode: SEED_PROFILE_SOURCE_ID,
  });

  await embedBatch(
    observations.map((item) => ({
      text: item.text,
      metadata: {
        type: "observation" as const,
        timestamp: now,
        sessionId: SEED_PROFILE_SOURCE_ID,
        sourcePath: SEED_PROFILE_SOURCE_PATH,
        sourceType: "onboarding" as const,
        sourceId: `${SEED_PROFILE_SOURCE_ID}:${item.field}`,
        sourceEpisode: SEED_PROFILE_SOURCE_ID,
        qualityScore: item.qualityScore,
        provenance: {
          writer: "onboarding.seed-builder",
          observationKind: "profile",
          knowledgeScope: "seed",
          epistemicStatus: "seed_stated",
          confidenceBand: "high",
          immutable: true,
          field: item.field,
          subjectName: answers.name,
        },
      },
    }))
  );

  await Promise.all(
    observations.map((item) =>
      recordMemoryWrite({
        eventId: `observation:${SEED_PROFILE_SOURCE_ID}:${item.field}:${now}`,
        memoryKey: `observation:${SEED_PROFILE_SOURCE_ID}:${item.field}`,
        memoryType: "observation",
        action: "upsert",
        text: item.text,
        timestamp: now,
        sessionId: SEED_PROFILE_SOURCE_ID,
        sourceType: "onboarding",
        sourcePath: SEED_PROFILE_SOURCE_PATH,
        sourceId: `${SEED_PROFILE_SOURCE_ID}:${item.field}`,
        sourceEpisode: SEED_PROFILE_SOURCE_ID,
        qualityScore: item.qualityScore,
        provenance: {
          writer: "onboarding.seed-builder",
          observationKind: "profile",
          knowledgeScope: "seed",
          epistemicStatus: "seed_stated",
          confidenceBand: "high",
          immutable: true,
          field: item.field,
          subjectName: answers.name,
        },
      })
    )
  );

  return observations.length;
}

export async function buildSeed(answers: OnboardingAnswers): Promise<void> {
  if (await seedExists()) {
    throw new Error("Seed already exists. Identity seed is immutable once set.");
  }

  await initCollection();

  await fs.mkdir(IDENTITY_DIR, { recursive: true });
  const markdown = buildSeedMarkdown(answers);
  await fs.writeFile(SEED_PATH, markdown, "utf-8");

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

  const now = new Date().toISOString();
  await embed(markdown, {
    type: "seed",
    timestamp: now,
    sourcePath: "identity/seed.md",
    sourceType: "onboarding",
    sourceId: "identity-seed",
    qualityScore: 1,
    provenance: {
      writer: "onboarding.seed-builder",
      granularity: "document",
    },
  });

  await recordMemoryWrite({
    eventId: "seed:identity-seed:captured",
    memoryKey: "seed:identity-seed",
    memoryType: "seed",
    action: "capture",
    text: markdown,
    timestamp: now,
    sourceType: "onboarding",
    sourcePath: "identity/seed.md",
    sourceId: "identity-seed",
    qualityScore: 1,
    provenance: {
      writer: "onboarding.seed-builder",
      granularity: "document",
      answerFields: Object.keys(answers),
    },
  });

  await syncSeedProfileMemories(answers);
}
