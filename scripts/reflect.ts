#!/usr/bin/env tsx
/**
 * CLI: npm run reflect
 *
 * Options:
 *   --contradictions  Only run contradiction analysis
 *   --loops           Only run open loop analysis
 *   --focus           Only run focus analysis
 *   --patterns        Only run pattern analysis
 *   --json            Output raw JSON instead of formatted text
 */

import "dotenv/config";
import { runReflection, type ReflectionSection } from "../cecil/reflection";
import { ensureWorldModelSchema, getWorldModelSummary } from "../cecil/world-model";
import { initStructuredMemory } from "../cecil/memory-store";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");

const sectionMap: Record<string, ReflectionSection> = {
  "--contradictions": "contradictions",
  "--loops": "openLoops",
  "--focus": "focus",
  "--patterns": "patterns",
};

const requestedSections = args
  .filter((a) => a in sectionMap)
  .map((a) => sectionMap[a]);

async function main() {
  await initStructuredMemory();
  ensureWorldModelSchema();

  const summary = getWorldModelSummary();
  if (!jsonOutput) {
    console.log("\n=== CECIL REFLECTION ===");
    console.log(
      `World model: ${summary.entities} entities, ${summary.beliefs} beliefs, ${summary.openLoops} open loops, ${summary.contradictions} contradictions\n`
    );
  }

  const report = await runReflection(
    requestedSections.length > 0 ? requestedSections : undefined
  );

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.contradictions !== "(skipped)") {
    console.log("--- CONTRADICTIONS ---");
    console.log(report.contradictions);
    console.log();
  }

  if (report.openLoops !== "(skipped)") {
    console.log("--- OPEN LOOPS ---");
    console.log(report.openLoops);
    console.log();
  }

  if (report.focus !== "(skipped)") {
    console.log("--- FOCUS ANALYSIS ---");
    console.log(report.focus);
    console.log();
  }

  if (report.patterns !== "(skipped)") {
    console.log("--- PATTERNS ---");
    console.log(report.patterns);
    console.log();
  }

  console.log(`Generated at: ${report.generatedAt}`);
}

main().catch((err) => {
  console.error("Reflection failed:", err);
  process.exit(1);
});
