import { NextRequest, NextResponse } from "next/server";
import { initStructuredMemory } from "@/cecil/memory-store";
import {
  ensureWorldModelSchema,
  listEntities,
  findEntityByName,
  type EntityKind,
} from "@/cecil/world-model";

export async function GET(req: NextRequest) {
  try {
    await initStructuredMemory();
    ensureWorldModelSchema();

    const kind = req.nextUrl.searchParams.get("kind") as EntityKind | null;
    const name = req.nextUrl.searchParams.get("name");

    if (name) {
      const entity = findEntityByName(name);
      return NextResponse.json({ entity });
    }

    const entities = listEntities(kind ?? undefined);
    return NextResponse.json({ entities });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list entities" },
      { status: 500 }
    );
  }
}
