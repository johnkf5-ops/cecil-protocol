import { NextResponse } from "next/server";
import { seedExists } from "@/onboarding/seed-builder";

export async function GET() {
  const onboarded = await seedExists();
  // v2: Always report as ready — onboarding is optional now
  return NextResponse.json({ onboarded: true, seedExists: onboarded });
}
