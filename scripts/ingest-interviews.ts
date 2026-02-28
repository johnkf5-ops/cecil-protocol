/**
 * Ingest interview podcast transcripts into Cecil's Qdrant memory.
 * Reads JSON transcripts from podcasts/interviews/transcripts/,
 * chunks them into ~10-minute blocks, and embeds into Qdrant.
 *
 * Usage: npx tsx scripts/ingest-interviews.ts
 */

import fs from "fs/promises";
import path from "path";
import { embed, embedBatch, initCollection } from "../cecil/embedder";
import type { MemoryMetadata } from "../cecil/types";

const TRANSCRIPT_DIR = path.join(process.cwd(), "podcasts", "interviews", "transcripts");
const MEMORY_DIR = path.join(process.cwd(), "memory", "interviews");

const CHUNK_DURATION_SECONDS = 600; // ~10 minutes per chunk

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface Transcript {
  sourceFile: string;
  title: string;
  durationMinutes: number;
  segmentCount: number;
  segments: TranscriptSegment[];
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
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

async function ingestTranscript(transcript: Transcript): Promise<number> {
  const now = new Date().toISOString();
  let vectorCount = 0;

  // Write human-readable markdown
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  const mdPath = path.join(MEMORY_DIR, `${transcript.title}.md`);
  const mdLines = [
    `# Interview: ${transcript.title}`,
    ``,
    `**Source:** ${transcript.sourceFile}`,
    `**Duration:** ${transcript.durationMinutes} minutes`,
    `**Segments:** ${transcript.segmentCount}`,
    ``,
    `---`,
    ``,
    ...transcript.segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`),
  ];
  await fs.writeFile(mdPath, mdLines.join("\n"), "utf-8");

  // Embed full episode as one vector (first 5000 chars)
  const fullText = transcript.segments.map((s) => s.text).join(" ");
  const label = `[Interview: ${transcript.title}] ${fullText.slice(0, 5000)}`;

  await embed(label, {
    type: "podcast",
    timestamp: now,
    sessionId: `interview-${transcript.title}`,
    sourcePath: `memory/interviews/${transcript.title}.md`,
  });
  vectorCount++;

  // Chunk into ~10-minute segments and batch embed
  const chunks = chunkTranscript(transcript.segments);
  if (chunks.length > 0) {
    const items = chunks.map((chunk, i) => ({
      text: `[Interview: ${transcript.title}, ${formatTimestamp(chunk.start)}-${formatTimestamp(chunk.end)}] ${chunk.text}`,
      metadata: {
        type: "podcast" as const,
        timestamp: now,
        sessionId: `interview-${transcript.title}-chunk-${i}`,
        sourcePath: `memory/interviews/${transcript.title}.md`,
      } satisfies MemoryMetadata,
    }));

    await embedBatch(items);
    vectorCount += items.length;
  }

  return vectorCount;
}

async function main() {
  await initCollection();

  let files: string[];
  try {
    files = await fs.readdir(TRANSCRIPT_DIR);
  } catch {
    console.error(`No transcripts directory at ${TRANSCRIPT_DIR}`);
    process.exit(1);
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

  if (jsonFiles.length === 0) {
    console.error("No transcript JSON files found.");
    process.exit(1);
  }

  let totalVectors = 0;

  for (const file of jsonFiles) {
    const raw = await fs.readFile(path.join(TRANSCRIPT_DIR, file), "utf-8");
    const transcript: Transcript = JSON.parse(raw);

    console.log(`Ingesting: ${transcript.title} (${transcript.durationMinutes} min)`);
    const vectors = await ingestTranscript(transcript);
    totalVectors += vectors;
    console.log(`  → ${vectors} vectors embedded`);
  }

  console.log(`\nDone. ${totalVectors} total vectors from ${jsonFiles.length} interviews.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
