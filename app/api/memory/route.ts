import { NextRequest, NextResponse } from "next/server";
import { buildMemoryAudit } from "@/cecil/memory-audit";
import { buildRecallWindow } from "@/cecil/recall-window";
import {
  getCurrentMemories,
  getMemoryEvents,
  getRankedRecallCandidates,
} from "@/cecil/memory-store";
import type { MemoryType } from "@/cecil/types";

function parseTypes(raw: string | null): MemoryType[] | undefined {
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? (values as MemoryType[]) : undefined;
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const types = parseTypes(params.get("types"));
  const limit = parsePositiveInt(params.get("limit"), 10);
  const query = params.get("query")?.trim();
  const includeEvents = params.get("includeEvents") !== "false";
  const includeWindow = params.get("includeWindow") === "true";
  const includeAudit = params.get("includeAudit") === "true";

  try {
    const [current, events, ranked, recallWindow, audit] = await Promise.all([
      getCurrentMemories({ types, limit }),
      includeEvents ? getMemoryEvents({ types, limit }) : Promise.resolve([]),
      query
        ? getRankedRecallCandidates(query, { types, limit })
        : Promise.resolve([]),
      query && includeWindow
        ? buildRecallWindow(query, { types })
        : Promise.resolve(null),
      includeAudit
        ? buildMemoryAudit({ query, limit: Math.max(limit, 250) })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      current,
      events,
      ranked,
      recallWindow,
      audit,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to inspect structured memory",
      },
      { status: 500 }
    );
  }
}
