import fs from "fs/promises";
import path from "path";
import { embed, embedBatch, initCollection } from "./embedder";
import { recordMemoryWrite } from "./memory-store";
import type { MemoryMetadata } from "./types";

const TRANSCRIPT_DIR = path.join(process.cwd(), "podcasts", "transcripts");
const PODCAST_MEMORY_DIR = path.join(process.cwd(), "memory", "podcasts");

// ~10 minutes of audio per chunk (roughly 1,500 words)
const CHUNK_DURATION_SECONDS = 600;

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface Transcript {
  episodeNumber: number;
  title: string;
  published: string;
  durationMinutes: number;
  segments: TranscriptSegment[];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/^-|-$/g, "");
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Chunk transcript segments into ~10-minute blocks.
 */
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
      chunks.push({
        start: chunkStart,
        end: chunkEnd,
        text: chunkTexts.join(" "),
      });
      chunkStart = seg.start;
      chunkTexts = [];
    }
    chunkTexts.push(seg.text);
    chunkEnd = seg.end;
  }

  // Final chunk
  if (chunkTexts.length > 0) {
    chunks.push({
      start: chunkStart,
      end: chunkEnd,
      text: chunkTexts.join(" "),
    });
  }

  return chunks;
}

/**
 * Write a human-readable markdown transcript for an episode.
 */
async function writeMarkdownTranscript(transcript: Transcript): Promise<string> {
  const slug = slugify(transcript.title);
  const filename = `episode-${transcript.episodeNumber}-${slug}.md`;
  const filepath = path.join(PODCAST_MEMORY_DIR, filename);

  const lines: string[] = [
    `# Episode ${transcript.episodeNumber}: ${transcript.title}`,
    ``,
    `**Published:** ${transcript.published}`,
    `**Duration:** ${transcript.durationMinutes} minutes`,
    `**Segments:** ${transcript.segments.length}`,
    ``,
    `---`,
    ``,
  ];

  for (const seg of transcript.segments) {
    lines.push(`[${formatTimestamp(seg.start)}] ${seg.text}`);
  }

  await fs.writeFile(filepath, lines.join("\n"), "utf-8");
  return `memory/podcasts/${filename}`;
}

/**
 * Ingest a single episode: write markdown, embed full episode + chunks.
 */
async function ingestEpisode(transcript: Transcript): Promise<number> {
  const now = new Date().toISOString();
  let vectorCount = 0;
  const sourceEpisode = `episode-${transcript.episodeNumber}: ${transcript.title}`;
  const sourceId = `podcast-ep-${transcript.episodeNumber}`;

  // Write human-readable markdown
  const sourcePath = await writeMarkdownTranscript(transcript);

  // Embed full episode as one vector
  const fullText = transcript.segments.map((s) => s.text).join(" ");
  const episodeLabel = `[Podcast Episode ${transcript.episodeNumber}: ${transcript.title}] ${fullText.slice(0, 5000)}`;

  await embed(episodeLabel, {
    type: "podcast",
    timestamp: now,
    sessionId: sourceId,
    sourcePath,
    sourceType: "podcast_ingest",
    sourceId,
    sourceEpisode,
    qualityScore: 0.72,
    provenance: {
      writer: "podcast-ingest.ingestEpisode",
      granularity: "episode",
      published: transcript.published,
      durationMinutes: transcript.durationMinutes,
      segmentCount: transcript.segments.length,
    },
  });
  vectorCount++;

  await recordMemoryWrite({
    eventId: `${sourceId}:full:capture`,
    memoryKey: `podcast:${sourceId}`,
    memoryType: "podcast",
    action: "upsert",
    text: episodeLabel,
    timestamp: now,
    sessionId: sourceId,
    sourceType: "podcast_ingest",
    sourcePath,
    sourceId,
    sourceEpisode,
    qualityScore: 0.72,
    provenance: {
      writer: "podcast-ingest.ingestEpisode",
      granularity: "episode",
      published: transcript.published,
      durationMinutes: transcript.durationMinutes,
      segmentCount: transcript.segments.length,
    },
  });

  // Chunk into ~10-minute segments and batch embed
  const chunks = chunkTranscript(transcript.segments);
  if (chunks.length > 0) {
    const items = chunks.map((chunk, i) => ({
      text: `[Podcast Episode ${transcript.episodeNumber}: ${transcript.title}, ${formatTimestamp(chunk.start)}-${formatTimestamp(chunk.end)}] ${chunk.text}`,
      metadata: {
        type: "podcast" as const,
        timestamp: now,
        sessionId: `${sourceId}-chunk-${i}`,
        sourcePath,
        sourceType: "podcast_ingest" as const,
        sourceId: `${sourceId}-chunk-${i}`,
        sourceEpisode,
        qualityScore: 0.64,
        provenance: {
          writer: "podcast-ingest.ingestEpisode",
          granularity: "chunk",
          chunkIndex: i,
          chunkStartSeconds: chunk.start,
          chunkEndSeconds: chunk.end,
          published: transcript.published,
        },
      } satisfies MemoryMetadata,
    }));

    await embedBatch(items);
    await Promise.all(
      chunks.map((chunk, i) =>
        recordMemoryWrite({
          eventId: `${sourceId}:chunk:${i}:capture`,
          memoryKey: `podcast:${sourceId}:chunk:${i}`,
          memoryType: "podcast",
          action: "upsert",
          text: items[i].text,
          timestamp: now,
          sessionId: `${sourceId}-chunk-${i}`,
          sourceType: "podcast_ingest",
          sourcePath,
          sourceId: `${sourceId}-chunk-${i}`,
          sourceEpisode,
          qualityScore: 0.64,
          provenance: {
            writer: "podcast-ingest.ingestEpisode",
            granularity: "chunk",
            chunkIndex: i,
            chunkStartSeconds: chunk.start,
            chunkEndSeconds: chunk.end,
            published: transcript.published,
          },
        })
      )
    );
    vectorCount += items.length;
  }

  return vectorCount;
}

/**
 * Ingest all podcast transcripts from the transcripts directory.
 * Returns summary of what was ingested.
 */
export async function ingestAllPodcasts(): Promise<{
  episodes: number;
  vectors: number;
  titles: string[];
}> {
  await initCollection();
  await fs.mkdir(PODCAST_MEMORY_DIR, { recursive: true });

  // Read all transcript JSON files
  let files: string[];
  try {
    files = await fs.readdir(TRANSCRIPT_DIR);
  } catch {
    throw new Error(
      `No transcripts directory found at ${TRANSCRIPT_DIR}. Run the transcription script first.`
    );
  }

  const jsonFiles = files
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => {
      const numA = parseInt(a.match(/episode-(\d+)/)?.[1] || "0");
      const numB = parseInt(b.match(/episode-(\d+)/)?.[1] || "0");
      return numA - numB;
    });

  if (jsonFiles.length === 0) {
    throw new Error("No transcript JSON files found. Run the transcription script first.");
  }

  let totalVectors = 0;
  const titles: string[] = [];

  for (const file of jsonFiles) {
    const raw = await fs.readFile(path.join(TRANSCRIPT_DIR, file), "utf-8");
    const transcript: Transcript = JSON.parse(raw);

    console.log(`Ingesting episode ${transcript.episodeNumber}: ${transcript.title}`);
    const vectors = await ingestEpisode(transcript);
    totalVectors += vectors;
    titles.push(transcript.title);
    console.log(`  → ${vectors} vectors embedded`);
  }

  return {
    episodes: jsonFiles.length,
    vectors: totalVectors,
    titles,
  };
}
