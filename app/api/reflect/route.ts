import { NextRequest, NextResponse } from "next/server";
import { runReflection, type ReflectionSection } from "@/cecil/reflection";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const sections: ReflectionSection[] | undefined = Array.isArray(body.sections)
      ? body.sections
      : undefined;

    const report = await runReflection(sections);
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reflection failed" },
      { status: 500 }
    );
  }
}
