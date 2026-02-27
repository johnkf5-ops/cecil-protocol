import { NextRequest, NextResponse } from "next/server";
import { ingestAllPodcasts } from "@/cecil/podcast-ingest";
import { synthesizePodcasts } from "@/cecil/podcast-observer";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const synthesize = body.synthesize !== false; // default: true

  try {
    // Step 1: Ingest all transcripts into Qdrant (skip if synthesizeOnly)
    let ingestResult = null;
    if (!body.synthesizeOnly) {
      ingestResult = await ingestAllPodcasts();
    }

    // Step 2: Run synthesis if requested
    let synthesisResult = null;
    if (synthesize || body.synthesizeOnly) {
      synthesisResult = await synthesizePodcasts();
    }

    return NextResponse.json({
      ingestion: ingestResult,
      synthesis: synthesisResult,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Podcast ingestion failed" },
      { status: 500 }
    );
  }
}
