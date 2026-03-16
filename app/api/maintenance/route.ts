import { NextRequest, NextResponse } from "next/server";
import { runMaintenance } from "@/cecil/maintenance";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const steps = Array.isArray(body.steps) ? body.steps : undefined;

    const report = await runMaintenance({ dryRun, steps });
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Maintenance failed" },
      { status: 500 }
    );
  }
}
