import { NextRequest, NextResponse } from "next/server";
import { initStructuredMemory } from "@/cecil/memory-store";
import { ensureWorldModelSchema, listContradictions } from "@/cecil/world-model";

export async function GET(req: NextRequest) {
  try {
    await initStructuredMemory();
    ensureWorldModelSchema();

    const unresolvedOnly = req.nextUrl.searchParams.get("all") !== "true";
    const contradictions = listContradictions(unresolvedOnly);
    return NextResponse.json({ contradictions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list contradictions" },
      { status: 500 }
    );
  }
}
