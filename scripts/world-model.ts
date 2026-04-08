/**
 * CLI tool for inspecting and rebuilding the world model.
 *
 * Usage:
 *   npx tsx scripts/world-model.ts              # Show summary
 *   npx tsx scripts/world-model.ts --rebuild    # Rebuild from memories
 *   npx tsx scripts/world-model.ts --entities   # List all entities
 *   npx tsx scripts/world-model.ts --beliefs    # List active beliefs
 *   npx tsx scripts/world-model.ts --loops      # List open loops
 *   npx tsx scripts/world-model.ts --contradictions  # List contradictions
 */

import "dotenv/config";
import {
  ensureWorldModelSchema,
  rebuildWorldModel,
  getWorldModelSummary,
  listEntities,
  listBeliefs,
  listOpenLoops,
  listContradictions,
} from "../cecil/world-model";

async function main() {
  const args = process.argv.slice(2);
  ensureWorldModelSchema();

  if (args.includes("--rebuild")) {
    console.log("Rebuilding world model from memories...\n");
    const summary = await rebuildWorldModel();
    console.log("World model rebuilt:");
    console.log(`  Entities:       ${summary.entities}`);
    console.log(`  Beliefs:        ${summary.beliefs}`);
    console.log(`  Open loops:     ${summary.openLoops}`);
    console.log(`  Contradictions: ${summary.contradictions}`);
    return;
  }

  if (args.includes("--entities")) {
    const entities = listEntities();
    console.log(`\n=== ENTITIES (${entities.length}) ===\n`);
    for (const e of entities) {
      console.log(
        `  [${e.kind}] ${e.name} — ${e.mentionCount} mentions (first: ${e.firstSeen.slice(0, 10)}, last: ${e.lastSeen.slice(0, 10)})`
      );
    }
    return;
  }

  if (args.includes("--beliefs")) {
    const beliefs = listBeliefs("active");
    console.log(`\n=== ACTIVE BELIEFS (${beliefs.length}) ===\n`);
    for (const b of beliefs) {
      console.log(`  • ${b.content}`);
      const parts = [`stated: ${b.lastStated.slice(0, 10)}`];
      if (b.validFrom) parts.push(`from: ${b.validFrom.slice(0, 10)}`);
      if (b.validTo) parts.push(`to: ${b.validTo.slice(0, 10)}`);
      console.log(`    (${parts.join(", ")})\n`);
    }
    return;
  }

  if (args.includes("--loops")) {
    const loops = listOpenLoops("open");
    console.log(`\n=== OPEN LOOPS (${loops.length}) ===\n`);
    for (const ol of loops) {
      console.log(`  • ${ol.content}`);
      console.log(`    (detected: ${ol.detectedAt.slice(0, 10)})\n`);
    }
    return;
  }

  if (args.includes("--contradictions")) {
    const contradictions = listContradictions(true);
    console.log(`\n=== UNRESOLVED CONTRADICTIONS (${contradictions.length}) ===\n`);
    for (const c of contradictions) {
      console.log(`  Earlier: ${c.statementA}`);
      console.log(`  Later:   ${c.statementB}`);
      console.log(`  (detected: ${c.detectedAt.slice(0, 10)})\n`);
    }
    return;
  }

  // Default: show summary
  const summary = getWorldModelSummary();
  console.log("\n=== WORLD MODEL SUMMARY ===\n");
  console.log(`  Entities:       ${summary.entities}`);
  console.log(`  Active beliefs: ${summary.beliefs}`);
  console.log(`  Open loops:     ${summary.openLoops}`);
  console.log(`  Contradictions: ${summary.contradictions}`);
  console.log(
    "\nUse --rebuild to populate from existing memories."
  );
  console.log(
    "Use --entities, --beliefs, --loops, or --contradictions to inspect."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
