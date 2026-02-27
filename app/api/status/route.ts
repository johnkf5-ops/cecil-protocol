import { NextResponse } from "next/server";
import { seedExists } from "@/onboarding/seed-builder";

export async function GET() {
  const onboarded = await seedExists();
  return NextResponse.json({ onboarded });
}
