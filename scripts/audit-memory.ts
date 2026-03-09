import { buildMemoryAudit } from "../cecil/memory-audit";
import { initStructuredMemory } from "../cecil/memory-store";

interface AuditOptions {
  query?: string;
  limit: number;
}

function parseArgs(argv: string[]): AuditOptions {
  const options: AuditOptions = {
    limit: 500,
  };

  for (const arg of argv) {
    if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length).trim() || undefined;
    } else if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.limit = parsed;
      }
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

  const audit = await buildMemoryAudit({
    query: options.query,
    limit: options.limit,
  });

  printSection("TOTALS", [
    `current=${audit.totals.current}`,
    `events=${audit.totals.events}`,
    `typesPresent=${audit.totals.typesPresent}`,
    `sourceTypesPresent=${audit.totals.sourceTypesPresent}`,
  ]);

  printSection(
    "BY TYPE",
    audit.byType.map(
      (item) =>
        `- ${item.memoryType} | current=${item.currentCount} | events=${item.eventCount} | avgQ=${item.averageQualityScore.toFixed(
          2
        )}${item.newestCurrentAt ? ` | latest=${item.newestCurrentAt}` : ""}`
    )
  );

  printSection(
    "BY SOURCE",
    audit.bySource.map(
      (item) =>
        `- ${item.sourceType} | current=${item.currentCount} | events=${item.eventCount}`
    )
  );

  printSection(
    "ISSUES",
    audit.issues.map(
      (item) => `- ${item.severity.toUpperCase()} | ${item.code} | ${item.message}`
    )
  );

  printSection(
    "STALE",
    audit.stale.map(
      (item) =>
        `- ${item.memoryType} | latest=${item.newestCurrentAt ?? "n/a"} | ageDays=${Math.round(
          item.ageDays ?? 0
        )}`
    )
  );

  printSection(
    "LOW QUALITY",
    audit.lowQuality.map(
      (item) =>
        `- ${item.memoryType} | q=${item.qualityScore.toFixed(2)} | ${item.memoryKey}\n  ${item.text.slice(
          0,
          220
        )}`
    )
  );

  printSection(
    "DUPLICATES",
    audit.duplicateGroups.map(
      (item) =>
        `- ${item.memoryType} | count=${item.currentCount} | keys=${item.memoryKeys.join(
          ", "
        )}\n  ${item.text.slice(0, 220)}`
    )
  );

  if (options.query) {
    printSection(
      `RANKED PREVIEW FOR "${options.query}"`,
      audit.rankedPreview.map(
        (item) =>
          `- ${item.memoryType} | recall=${item.recallScore.toFixed(2)} | hits=${item.lexicalHits} | q=${item.qualityScore.toFixed(
            2
          )} | ${item.memoryKey}\n  ${item.text.slice(0, 220)}`
      )
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
