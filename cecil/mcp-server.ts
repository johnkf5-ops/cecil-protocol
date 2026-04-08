#!/usr/bin/env tsx
/**
 * Cecil MCP Server — Exposes Cecil as a tool server for
 * Claude Code, Claude Desktop, and other MCP clients.
 *
 * Transport: stdio
 * Run: npm run mcp
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initStructuredMemory, recordMemoryWrite } from "./memory-store";
import { initCollection, embed } from "./embedder";
import { buildRecallWindow } from "./recall-window";
import {
  ensureWorldModelSchema,
  listEntities,
  listBeliefs,
  listContradictions,
  listOpenLoops,
  type EntityKind,
} from "./world-model";
import { runReflection, type ReflectionSection } from "./reflection";
import { observe } from "./observer";
import type { Message, MemoryType } from "./types";
import { randomUUID } from "node:crypto";

const server = new McpServer({
  name: "cecil",
  version: "2.1.0",
});

// ── recall ───────────────────────────────────────────────────────────────────

server.tool(
  "recall",
  "Search Cecil's memory with ranked recall and world model context",
  {
    query: z.string().describe("The search query"),
  },
  async ({ query }) => {
    await initStructuredMemory();
    const window = await buildRecallWindow(query);
    return {
      content: [
        {
          type: "text" as const,
          text: window.formattedContext || "No relevant memories found.",
        },
      ],
    };
  }
);

// ── store ────────────────────────────────────────────────────────────────────

server.tool(
  "store",
  "Store a new memory in Cecil's memory system",
  {
    content: z.string().describe("The memory content to store"),
    type: z
      .enum(["conversation", "observation", "fact", "milestone"])
      .default("fact")
      .describe("Memory type"),
  },
  async ({ content, type }) => {
    await initStructuredMemory();
    await initCollection();

    const now = new Date().toISOString();
    const memoryKey = `${type}:mcp:${randomUUID().slice(0, 8)}`;

    await embed(content, {
      type: type as MemoryType,
      timestamp: now,
      sourceType: "conversation_session",
      sourceId: "mcp",
      qualityScore: 0.75,
      provenance: { writer: "mcp-server" },
    });

    await recordMemoryWrite({
      eventId: `${memoryKey}:captured`,
      memoryKey,
      memoryType: type as MemoryType,
      action: "capture",
      text: content,
      timestamp: now,
      sourceType: "conversation_session",
      sourceId: "mcp",
      qualityScore: 0.75,
      provenance: { writer: "mcp-server" },
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Stored as ${type}: ${memoryKey}`,
        },
      ],
    };
  }
);

// ── reflect ──────────────────────────────────────────────────────────────────

server.tool(
  "reflect",
  "Run Cecil's reflection agent to analyze contradictions, open loops, focus, and patterns",
  {
    section: z
      .enum(["contradictions", "openLoops", "focus", "patterns"])
      .optional()
      .describe("Run only a specific section (omit for full report)"),
  },
  async ({ section }) => {
    await initStructuredMemory();
    ensureWorldModelSchema();

    const sections: ReflectionSection[] | undefined = section
      ? [section]
      : undefined;
    const report = await runReflection(sections);

    const parts: string[] = [];
    if (report.contradictions !== "(skipped)") {
      parts.push(`## Contradictions\n${report.contradictions}`);
    }
    if (report.openLoops !== "(skipped)") {
      parts.push(`## Open Loops\n${report.openLoops}`);
    }
    if (report.focus !== "(skipped)") {
      parts.push(`## Focus Analysis\n${report.focus}`);
    }
    if (report.patterns !== "(skipped)") {
      parts.push(`## Patterns\n${report.patterns}`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: parts.join("\n\n") || "No reflection data available.",
        },
      ],
    };
  }
);

// ── entities ─────────────────────────────────────────────────────────────────

server.tool(
  "entities",
  "List tracked entities from Cecil's world model",
  {
    kind: z
      .enum(["person", "project", "organization", "place", "topic"])
      .optional()
      .describe("Filter by entity kind"),
  },
  async ({ kind }) => {
    await initStructuredMemory();
    ensureWorldModelSchema();

    const entities = listEntities(kind as EntityKind | undefined).slice(0, 30);

    if (entities.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No entities tracked yet." },
        ],
      };
    }

    const lines = entities.map(
      (e) =>
        `- **${e.name}** (${e.kind}) — ${e.mentionCount} mentions, last seen ${e.lastSeen}`
    );

    return {
      content: [
        { type: "text" as const, text: lines.join("\n") },
      ],
    };
  }
);

// ── contradictions ───────────────────────────────────────────────────────────

server.tool(
  "contradictions",
  "List unresolved contradictions from Cecil's world model",
  {},
  async () => {
    await initStructuredMemory();
    ensureWorldModelSchema();

    const contradictions = listContradictions(true).slice(0, 10);

    if (contradictions.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No unresolved contradictions.",
          },
        ],
      };
    }

    const lines = contradictions.map(
      (c) =>
        `- Earlier: "${c.statementA}"\n  Later: "${c.statementB}"\n  Detected: ${c.detectedAt}`
    );

    return {
      content: [
        { type: "text" as const, text: lines.join("\n\n") },
      ],
    };
  }
);

// ── openLoops ────────────────────────────────────────────────────────────────

server.tool(
  "openLoops",
  "List open loops (unresolved TODOs and follow-ups)",
  {},
  async () => {
    await initStructuredMemory();
    ensureWorldModelSchema();

    const loops = listOpenLoops("open").slice(0, 15);

    if (loops.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No open loops." },
        ],
      };
    }

    const lines = loops.map(
      (ol) => `- ${ol.content} (since ${ol.detectedAt})`
    );

    return {
      content: [
        { type: "text" as const, text: lines.join("\n") },
      ],
    };
  }
);

// ── observe ──────────────────────────────────────────────────────────────────

server.tool(
  "observe",
  "Trigger the Cecil observer pipeline on a set of messages",
  {
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        })
      )
      .describe("The conversation messages to observe"),
  },
  async ({ messages }) => {
    await initStructuredMemory();
    await initCollection();

    const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
    const result = await observe(messages as Message[], sessionId);

    return {
      content: [
        {
          type: "text" as const,
          text: result.didSynthesize
            ? `Observed and synthesized (session: ${sessionId})`
            : result.alreadyObserved
              ? "Session was already observed."
              : `Light pass complete (session: ${sessionId})`,
        },
      ],
    };
  }
);

// ── Start server ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});
