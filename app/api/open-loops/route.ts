import { NextRequest, NextResponse } from "next/server";
import { initStructuredMemory } from "@/cecil/memory-store";
import { ensureWorldModelSchema, listOpenLoops, type OpenLoopStatus } from "@/cecil/world-model";

export async function GET(req: NextRequest) {
  try {
    await initStructuredMemory();
    ensureWorldModelSchema();

    const status = req.nextUrl.searchParams.get("status") as OpenLoopStatus | null;
    const loops = listOpenLoops(status ?? undefined);
    return NextResponse.json({ openLoops: loops });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list open loops" },
      { status: 500 }
    );
  }
}
