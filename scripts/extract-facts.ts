/**
 * Extract structured facts from all podcast transcripts and embed into Qdrant.
 * Processes both episode transcripts and interview transcripts.
 *
 * Usage: npx tsx scripts/extract-facts.ts
 */

import fs from "fs/promises";
import path from "path";
import { createHash } from "node:crypto";
import { embedBatch, initCollection } from "../cecil/embedder";
import { extractFacts } from "../cecil/fact-extractor";
import { recordMemoryWrite } from "../cecil/memory-store";
import type { MemoryMetadata } from "../cecil/types";

const PODCAST_TRANSCRIPT_DIR = path.join(process.cwd(), "podcasts", "transcripts");
const INTERVIEW_TRANSCRIPT_DIR = path.join(process.cwd(), "podcasts", "interviews", "transcripts");
const FACT_LOG_DIR = path.join(process.cwd(), "memory", "facts");
const MILESTONE_LOG_DIR = path.join(process.cwd(), "memory", "milestones");

const CHUNK_DURATION_SECONDS = 600; // ~10 minutes per chunk

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

function makeStableId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function chunkTranscript(
  segments: TranscriptSegment[]
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
    chunkTexts.push(seg.text);
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

  const segments: TranscriptSegment[] = transcript.segments || [];
  const chunks = chunkTranscript(segments);

  if (chunks.length === 0) {
    console.log(`  No chunks for ${episodeLabel}`);
    return { facts: 0, chunks: 0 };
  }

  const allFactItems: { text: string; metadata: MemoryMetadata }[] = [];
  const factLog: string[] = [`# Facts: ${episodeLabel}\n`];
  const milestoneLog: string[] = [`# Milestones: ${episodeLabel}\n`];
  const structuredWrites: Promise<void>[] = [];
  const factLogPath = path.join(FACT_LOG_DIR, `${episodeLabel}.md`);
  const milestoneLogPath = path.join(MILESTONE_LOG_DIR, `${episodeLabel}.md`);
  const factSourcePath = `memory/facts/${episodeLabel}.md`;
  const milestoneSourcePath = `memory/milestones/${episodeLabel}.md`;

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  Chunk ${i + 1}/${chunks.length}...`);

    const facts = await extractFacts(chunks[i].text, episodeLabel);

    for (const fact of facts) {
      const timestamp = new Date().toISOString();
      const baseId = makeStableId(
        episodeLabel,
        String(i),
        fact.category,
        fact.fact
      );
      const sourceId = `fact-${baseId}`;

      allFactItems.push({
        text: fact.fact,
        metadata: {
          type: "fact",
          timestamp,
          sessionId: `fact-${episodeLabel}-chunk-${i}`,
          sourcePath: factSourcePath,
          sourceType: "fact_extraction",
          sourceId,
          sourceEpisode: episodeLabel,
          entities: fact.entities,
          category: fact.category,
          qualityScore: fact.category === "experience" ? 0.82 : 0.76,
          provenance: {
            writer: "extract-facts.processTranscriptFile",
            transcriptPath: filePath,
            chunkIndex: i,
            chunkStartSeconds: chunks[i].start,
            chunkEndSeconds: chunks[i].end,
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
          sessionId: `fact-${episodeLabel}-chunk-${i}`,
          sourceType: "fact_extraction",
          sourcePath: factSourcePath,
          sourceId,
          sourceEpisode: episodeLabel,
          qualityScore: fact.category === "experience" ? 0.82 : 0.76,
          provenance: {
            writer: "extract-facts.processTranscriptFile",
            transcriptPath: filePath,
            chunkIndex: i,
            chunkStartSeconds: chunks[i].start,
            chunkEndSeconds: chunks[i].end,
            entities: fact.entities,
            category: fact.category,
          },
        })
      );

      if (fact.category === "experience") {
        const milestoneSourceId = `milestone-${baseId}`;
        milestoneLog.push(`- ${fact.fact} (entities: ${fact.entities.join(", ")})`);
        structuredWrites.push(
          recordMemoryWrite({
            eventId: `milestone:${milestoneSourceId}:capture`,
            memoryKey: `milestone:${milestoneSourceId}`,
            memoryType: "milestone",
            action: "upsert",
            text: fact.fact,
            timestamp,
            sessionId: `fact-${episodeLabel}-chunk-${i}`,
            sourceType: "fact_extraction",
            sourcePath: milestoneSourcePath,
            sourceId: milestoneSourceId,
            sourceEpisode: episodeLabel,
            qualityScore: 0.84,
            provenance: {
              writer: "extract-facts.processTranscriptFile",
              derivedFrom: "fact",
              transcriptPath: filePath,
              chunkIndex: i,
              chunkStartSeconds: chunks[i].start,
              chunkEndSeconds: chunks[i].end,
              entities: fact.entities,
              category: fact.category,
            },
          })
        );
      }
    }

    console.log(` ${facts.length} facts`);
  }

  // Batch embed all facts for this episode
  if (allFactItems.length > 0) {
    await embedBatch(allFactItems);
  }

  // Write fact log for human review
  await fs.mkdir(FACT_LOG_DIR, { recursive: true });
  await fs.writeFile(factLogPath, factLog.join("\n"), "utf-8");

  if (milestoneLog.length > 1) {
    await fs.mkdir(MILESTONE_LOG_DIR, { recursive: true });
    await fs.writeFile(milestoneLogPath, milestoneLog.join("\n"), "utf-8");
  }

  await Promise.all(structuredWrites);

  return { facts: allFactItems.length, chunks: chunks.length };
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function main() {
  await initCollection();

  const podcastFiles = (await readDir(PODCAST_TRANSCRIPT_DIR))
    .filter((f) => f.endsWith(".json"))
    .sort();

  const interviewFiles = (await readDir(INTERVIEW_TRANSCRIPT_DIR))
    .filter((f) => f.endsWith(".json"))
    .sort();

  const totalFiles = podcastFiles.length + interviewFiles.length;
  if (totalFiles === 0) {
    console.error("No transcript files found.");
    process.exit(1);
  }

  console.log(`Found ${podcastFiles.length} podcast + ${interviewFiles.length} interview transcripts`);
  console.log(`Output: ${FACT_LOG_DIR}\n`);

  let totalFacts = 0;
  let totalChunks = 0;
  let fileIndex = 0;

  for (const file of podcastFiles) {
    fileIndex++;
    const episodeLabel = file.replace(".json", "");
    console.log(`[${fileIndex}/${totalFiles}] ${episodeLabel}`);
    const result = await processTranscriptFile(
      path.join(PODCAST_TRANSCRIPT_DIR, file),
      episodeLabel
    );
    totalFacts += result.facts;
    totalChunks += result.chunks;
    console.log(`  → ${result.facts} facts from ${result.chunks} chunks\n`);
  }

  for (const file of interviewFiles) {
    fileIndex++;
    const episodeLabel = file.replace(".json", "");
    console.log(`[${fileIndex}/${totalFiles}] ${episodeLabel}`);
    const result = await processTranscriptFile(
      path.join(INTERVIEW_TRANSCRIPT_DIR, file),
      episodeLabel
    );
    totalFacts += result.facts;
    totalChunks += result.chunks;
    console.log(`  → ${result.facts} facts from ${result.chunks} chunks\n`);
  }

  console.log("=".repeat(60));
  console.log(`COMPLETE`);
  console.log("=".repeat(60));
  console.log(`Files processed: ${totalFiles}`);
  console.log(`Chunks analyzed: ${totalChunks}`);
  console.log(`Facts extracted: ${totalFacts}`);
  console.log(`Fact logs: ${FACT_LOG_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
