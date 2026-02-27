import { NextRequest, NextResponse } from "next/server";
import { chat } from "@/cecil/meta";
import type { Message } from "@/cecil/types";

export async function POST(req: NextRequest) {
  const { messages }: { messages: Message[] } = await req.json();

  try {
    const result = await chat(messages);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chat failed" },
      { status: 500 }
    );
  }
}
