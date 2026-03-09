import { buildRecallWindow } from "../cecil/recall-window";
import {
  getCurrentMemories,
  getMemoryEvents,
  getRankedRecallCandidates,
  initStructuredMemory,
} from "../cecil/memory-store";
import type { MemoryType } from "../cecil/types";

interface InspectOptions {
  types?: MemoryType[];
  limit: number;
  query?: string;
  includeEvents: boolean;
  includeWindow: boolean;
}

function parseTypes(value?: string): MemoryType[] | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean) as MemoryType[];
}

function parseArgs(argv: string[]): InspectOptions {
  const options: InspectOptions = {
    limit: 10,
    includeEvents: true,
    includeWindow: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--types=")) {
      options.types = parseTypes(arg.slice("--types=".length));
    } else if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.limit = parsed;
      }
    } else if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length).trim() || undefined;
    } else if (arg === "--no-events") {
      options.includeEvents = false;
    } else if (arg === "--window") {
      options.includeWindow = true;
    }
  }

  return options;
}

function printSection(title: string, lines: string[]): void {
  console.log(`\n=== ${title} ===`);

  if (lines.length === 0) {
    console.log("(none)");
    return;
  }

  for (const line of lines) {
    console.log(line);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await initStructuredMemory();

  const [current, events, ranked, recallWindow] = await Promise.all([
    getCurrentMemories({
      types: options.types,
      limit: options.limit,
    }),
    options.includeEvents
      ? getMemoryEvents({
          types: options.types,
          limit: options.limit,
        })
      : Promise.resolve([]),
    options.query
      ? getRankedRecallCandidates(options.query, {
          types: options.types,
          limit: options.limit,
        })
      : Promise.resolve([]),
    options.query && options.includeWindow
      ? buildRecallWindow(options.query, { types: options.types })
      : Promise.resolve(null),
  ]);

  printSection(
    "CURRENT",
    current.map(
      (item) =>
        `- ${item.memoryType} | ${item.updatedAt} | q=${item.qualityScore.toFixed(2)} | ${item.memoryKey}${
          item.sourceEpisode ? ` | ${item.sourceEpisode}` : ""
        }\n  ${item.text.slice(0, 220)}`
    )
  );

  if (options.includeEvents) {
    printSection(
      "EVENTS",
      events.map(
        (item) =>
          `- ${item.action} | ${item.memoryType} | ${item.createdAt} | ${item.eventId}${
            item.sourceEpisode ? ` | ${item.sourceEpisode}` : ""
          }\n  ${item.text.slice(0, 220)}`
      )
    );
  }

  if (options.query) {
    printSection(
      `RANKED RECALL FOR "${options.query}"`,
      ranked.map(
        (item) =>
          `- ${item.memoryType} | recall=${item.recallScore.toFixed(2)} | hits=${item.lexicalHits} | q=${item.qualityScore.toFixed(2)} | ${item.memoryKey}${
            item.sourceEpisode ? ` | ${item.sourceEpisode}` : ""
          }\n  ${item.text.slice(0, 220)}`
      )
    );
  }

  if (recallWindow) {
    printSection(
      `MERGED RECALL WINDOW FOR "${options.query}"`,
      recallWindow.formattedContext
        ? recallWindow.formattedContext.split("\n")
        : []
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
