import { NextRequest, NextResponse } from "next/server";
import { buildSeed } from "@/onboarding/seed-builder";
import type { OnboardingAnswers } from "@/cecil/types";

export async function POST(req: NextRequest) {
  const answers: OnboardingAnswers = await req.json();

  try {
    await buildSeed(answers);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build seed" },
      { status: 400 }
    );
  }
}
