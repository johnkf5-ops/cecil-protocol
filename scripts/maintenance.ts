#!/usr/bin/env tsx
/**
 * CLI: npm run maintenance
 *
 * Options:
 *   --dry-run          Show what would happen without making changes
 *   --dedup            Only run dedup steps (exact + semantic)
 *   --semantic-dedup   Only run semantic dedup
 *   --quality          Only run quality sweep
 *   --stale-loops      Only run stale loop detection
 *   --contradictions   Only run contradiction refresh
 *   --entities         Only run entity refresh
 *   --beliefs          Only run belief refresh
 *   --json             Output raw JSON
 */

import "dotenv/config";
import { runMaintenance, type MaintenanceOptions } from "../cecil/maintenance";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonOutput = args.includes("--json");

const stepFlags: Record<string, MaintenanceOptions["steps"] extends (infer T)[] | undefined ? T : never> = {
  "--dedup": "dedup" as const,
  "--semantic-dedup": "semantic-dedup" as const,
  "--quality": "quality" as const,
  "--stale-loops": "stale-loops" as const,
  "--contradictions": "contradictions" as const,
  "--entities": "entities" as const,
  "--beliefs": "beliefs" as const,
};

const requestedSteps = args
  .filter((a) => a in stepFlags)
  .map((a) => stepFlags[a]);

// If --dedup is specified, include both exact and semantic
const steps: MaintenanceOptions["steps"] = requestedSteps.length > 0
  ? (requestedSteps.includes("dedup" as any)
      ? [...requestedSteps, "semantic-dedup" as any]
      : requestedSteps) as any
  : undefined;

async function main() {
  if (!jsonOutput) {
    console.log("\n=== CECIL MAINTENANCE ===");
    if (dryRun) console.log("(DRY RUN — no changes will be made)\n");
    else console.log();
  }

  const report = await runMaintenance({ dryRun, steps });

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Exact dedup:               ${report.exactDedups} retired`);
  console.log(`Semantic dedup:            ${report.semanticDedups} merged`);
  console.log(`Semantic dedup checked:    ${report.semanticDedupProcessed} memories`);
  console.log(`Quality sweep:             ${report.qualityRetired} retired (< 0.4)`);
  console.log(`Stale open loops:          ${report.staleLoops} marked stale (> 30 days)`);
  console.log(`Contradictions refreshed:  ${report.contradictionsRefreshed}`);
  console.log(`Entities refreshed:        ${report.entitiesRefreshed}`);
  console.log(`Beliefs refreshed:         ${report.beliefsRefreshed}`);
  console.log(`\nDuration: ${report.duration}ms`);
  if (dryRun) console.log("(No changes were made — this was a dry run)");
}

main().catch((err) => {
  console.error("Maintenance failed:", err);
  process.exit(1);
});
