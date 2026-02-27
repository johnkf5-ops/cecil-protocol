import { NextRequest, NextResponse } from "next/server";
import { observe } from "@/echo/observer";
import type { Message } from "@/echo/types";

export async function POST(req: NextRequest) {
  const { messages, sessionId }: { messages: Message[]; sessionId: string } =
    await req.json();

  try {
    const result = await observe(messages, sessionId);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Observer failed" },
      { status: 500 }
    );
  }
}
