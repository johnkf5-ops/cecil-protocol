/**
 * Extract structured facts from diarized podcast transcripts (episodes 1-21 only).
 * Reads from podcasts/transcripts-diarized/ and formats text with [HOST]/[GUEST] prefixes.
 *
 * Usage: npx tsx scripts/extract-diarized-facts.ts
 *
 * Prerequisites:
 *   1. Run diarize-episodes.py first to create diarized transcripts
 *   2. Run delete-episode-facts.ts to clear old facts from Qdrant
 *   3. Qdrant running at localhost:6333
 *   4. LM Studio running with Qwen 3.5 (thinking OFF, 32K context, 1 slot)
 */

import fs from "fs/promises";
import path from "path";
import { createHash } from "node:crypto";
import { embedBatch, initCollection } from "../cecil/embedder";
import { extractFactsDiarized } from "../cecil/fact-extractor";
import { recordMemoryWrite } from "../cecil/memory-store";
import type { MemoryMetadata } from "../cecil/types";

const DIARIZED_TRANSCRIPT_DIR = path.join(process.cwd(), "podcasts", "transcripts-diarized");
const FACT_LOG_DIR = path.join(process.cwd(), "memory", "facts");
const MILESTONE_LOG_DIR = path.join(process.cwd(), "memory", "milestones");

const CHUNK_DURATION_SECONDS = 600; // ~10 minutes per chunk

interface DiarizedSegment {
  start: number;
  end: number;
  text: string;
  speaker: "host" | "guest" | "unknown";
}

function makeStableId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function chunkDiarizedTranscript(
  segments: DiarizedSegment[]
): { start: number; end: number; text: string }[] {
  if (segments.length === 0) return [];

  const chunks: { start: number; end: number; text: string }[] = [];
  let chunkStart = segments[0].start;
  let chunkTexts: string[] = [];
  let chunkEnd = segments[0].end;

  for (const seg of segments) {
    if (seg.start - chunkStart >= CHUNK_DURATION_SECONDS && chunkTexts.length > 0) {
      chunks.push({ start: chunkStart, end: chunkEnd, text: chunkTexts.join(" ") });
      chunkStart = seg.start;
      chunkTexts = [];
    }

    // Prefix each segment with speaker label
    const prefix =
      seg.speaker === "host" ? "[HOST]" :
      seg.speaker === "guest" ? "[GUEST]" : "";
    chunkTexts.push(`${prefix} ${seg.text}`);
    chunkEnd = seg.end;
  }

  if (chunkTexts.length > 0) {
    chunks.push({ start: chunkStart, end: chunkEnd, text: chunkTexts.join(" ") });
  }

  return chunks;
}

async function processTranscriptFile(
  filePath: string,
  episodeLabel: string
): Promise<{ facts: number; chunks: number }> {
  const raw = await fs.readFile(filePath, "utf-8");
  const transcript = JSON.parse(raw);

  if (!transcript.diarized) {
    console.log(`  WARNING: ${episodeLabel} is not diarized, skipping`);
    return { facts: 0, chunks: 0 };
  }

  const segments: DiarizedSegment[] = transcript.segments || [];
  const chunks = chunkDiarizedTranscript(segments);

  if (chunks.length === 0) {
    console.log(`  No chunks for ${episodeLabel}`);
    return { facts: 0, chunks: 0 };
  }

  const episodeTitle = transcript.title || episodeLabel;
  const allFactItems: { text: string; metadata: MemoryMetadata }[] = [];
  const factLog: string[] = [`# Facts: ${episodeTitle} (diarized)\n`];
  const milestoneLog: string[] = [`# Milestones: ${episodeTitle} (diarized)\n`];
  const structuredWrites: Promise<void>[] = [];
  const factLogPath = path.join(FACT_LOG_DIR, `${episodeLabel}.md`);
  const milestoneLogPath = path.join(MILESTONE_LOG_DIR, `${episodeLabel}.md`);
  const factSourcePath = `memory/facts/${episodeLabel}.md`;
  const milestoneSourcePath = `memory/milestones/${episodeLabel}.md`;

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  Chunk ${i + 1}/${chunks.length}...`);

    const facts = await extractFactsDiarized(chunks[i].text, episodeTitle);

    for (const fact of facts) {
      const timestamp = new Date().toISOString();
      const baseId = makeStableId(
        episodeLabel,
        "diarized",
        String(i),
        fact.category,
        fact.fact
      );
      const sourceId = `fact-diarized-${baseId}`;

      allFactItems.push({
        text: fact.fact,
        metadata: {
          type: "fact",
          timestamp,
          sessionId: `fact-diarized-${episodeLabel}-chunk-${i}`,
          sourcePath: factSourcePath,
          sourceType: "fact_extraction",
          sourceId,
          sourceEpisode: episodeLabel,
          entities: fact.entities,
          category: fact.category,
          qualityScore: fact.category === "experience" ? 0.82 : 0.76,
          provenance: {
            writer: "extract-diarized-facts.processTranscriptFile",
            transcriptPath: filePath,
            chunkIndex: i,
            chunkStartSeconds: chunks[i].start,
            chunkEndSeconds: chunks[i].end,
            diarized: true,
          },
        },
      });
      factLog.push(
        `- [${fact.category}] ${fact.fact} (entities: ${fact.entities.join(", ")})`
      );

      structuredWrites.push(
        recordMemoryWrite({
          eventId: `fact:${sourceId}:capture`,
          memoryKey: `fact:${sourceId}`,
          memoryType: "fact",
          action: "upsert",
          text: fact.fact,
          timestamp,
          sessionId: `fact-diarized-${episodeLabel}-chunk-${i}`,
          sourceType: "fact_extraction",
          sourcePath: factSourcePath,
          sourceId,
          sourceEpisode: episodeLabel,
          qualityScore: fact.category === "experience" ? 0.82 : 0.76,
          provenance: {
            writer: "extract-diarized-facts.processTranscriptFile",
            transcriptPath: filePath,
            chunkIndex: i,
            chunkStartSeconds: chunks[i].start,
            chunkEndSeconds: chunks[i].end,
            diarized: true,
            entities: fact.entities,
            category: fact.category,
          },
        })
      );

      if (fact.category === "experience") {
        const milestoneSourceId = `milestone-diarized-${baseId}`;
        milestoneLog.push(
          `- ${fact.fact} (entities: ${fact.entities.join(", ")})`
        );
        structuredWrites.push(
          recordMemoryWrite({
            eventId: `milestone:${milestoneSourceId}:capture`,
            memoryKey: `milestone:${milestoneSourceId}`,
            memoryType: "milestone",
            action: "upsert",
            text: fact.fact,
            timestamp,
            sessionId: `fact-diarized-${episodeLabel}-chunk-${i}`,
            sourceType: "fact_extraction",
            sourcePath: milestoneSourcePath,
            sourceId: milestoneSourceId,
            sourceEpisode: episodeLabel,
            qualityScore: 0.84,
            provenance: {
              writer: "extract-diarized-facts.processTranscriptFile",
              derivedFrom: "fact",
              transcriptPath: filePath,
              chunkIndex: i,
              chunkStartSeconds: chunks[i].start,
              chunkEndSeconds: chunks[i].end,
              diarized: true,
              entities: fact.entities,
              category: fact.category,
            },
          })
        );
      }
    }

    console.log(` ${facts.length} facts`);
  }

  if (allFactItems.length > 0) {
    await embedBatch(allFactItems);
  }

  await fs.mkdir(FACT_LOG_DIR, { recursive: true });
  await fs.writeFile(factLogPath, factLog.join("\n"), "utf-8");

  if (milestoneLog.length > 1) {
    await fs.mkdir(MILESTONE_LOG_DIR, { recursive: true });
    await fs.writeFile(milestoneLogPath, milestoneLog.join("\n"), "utf-8");
  }

  await Promise.all(structuredWrites);

  return { facts: allFactItems.length, chunks: chunks.length };
}

async function main() {
  await initCollection();

  // Only process episodes 1-21 (diarized Unfiltered episodes)
  const files: string[] = [];
  for (let ep = 1; ep <= 21; ep++) {
    const filename = `episode-${ep}.json`;
    const filePath = path.join(DIARIZED_TRANSCRIPT_DIR, filename);
    try {
      await fs.access(filePath);
      files.push(filename);
    } catch {
      console.warn(`Missing diarized transcript: ${filename}`);
    }
  }

  if (files.length === 0) {
    console.error("No diarized transcripts found in", DIARIZED_TRANSCRIPT_DIR);
    console.error("Run diarize-episodes.py first.");
    process.exit(1);
  }

  console.log(`Found ${files.length} diarized transcripts`);
  console.log(`Output: ${FACT_LOG_DIR}\n`);

  let totalFacts = 0;
  let totalChunks = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const episodeLabel = file.replace(".json", "");

    // Skip already-processed episodes (resume support)
    const logPath = path.join(FACT_LOG_DIR, `${episodeLabel}.md`);
    try {
      const existing = await fs.readFile(logPath, "utf-8");
      if (existing.includes("(diarized)")) {
        console.log(`[${i + 1}/${files.length}] ${episodeLabel} — already processed, skipping`);
        continue;
      }
    } catch {
      // No log file — process this episode
    }

    console.log(`[${i + 1}/${files.length}] ${episodeLabel}`);
    const result = await processTranscriptFile(
      path.join(DIARIZED_TRANSCRIPT_DIR, file),
      episodeLabel
    );
    totalFacts += result.facts;
    totalChunks += result.chunks;
    console.log(`  → ${result.facts} facts from ${result.chunks} chunks\n`);
  }

  console.log("=".repeat(60));
  console.log("COMPLETE");
  console.log("=".repeat(60));
  console.log(`Files processed: ${files.length}`);
  console.log(`Chunks analyzed: ${totalChunks}`);
  console.log(`Facts extracted: ${totalFacts}`);
  console.log(`Fact logs: ${FACT_LOG_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
