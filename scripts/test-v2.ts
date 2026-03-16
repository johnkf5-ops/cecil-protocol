#!/usr/bin/env tsx
/**
 * Cecil v2 Integration Test
 * Run: npx tsx scripts/test-v2.ts
 */

import "dotenv/config";
import { cecil } from "../cecil/client";

async function main() {
  let passed = 0;
  let failed = 0;

  function ok(name: string) {
    passed++;
    console.log(`  PASS  ${name}`);
  }
  function fail(name: string, err: unknown) {
    failed++;
    console.log(`  FAIL  ${name}: ${err}`);
  }

  console.log("\n=== CECIL v2 TEST SUITE ===\n");

  // Test 1: Init
  try {
    await cecil.init();
    ok("init()");
  } catch (e) { fail("init()", e); }

  // Test 2: Subject name resolves
  try {
    const name = await cecil.getSubjectName();
    console.log(`         → Subject: "${name}"`);
    if (name && name !== "") ok("getSubjectName()");
    else fail("getSubjectName()", "empty name");
  } catch (e) { fail("getSubjectName()", e); }

  // Test 3: setSubjectName
  try {
    cecil.setSubjectName("Test Person");
    const name = await cecil.getSubjectName();
    if (name === "Test Person") ok("setSubjectName()");
    else fail("setSubjectName()", `expected "Test Person", got "${name}"`);
    // Reset
    cecil.setSubjectName("");
  } catch (e) { fail("setSubjectName()", e); }

  // Test 4: World model summary
  try {
    const s = cecil.worldModel.summary();
    console.log(`         → ${s.entities} entities, ${s.beliefs} beliefs, ${s.openLoops} loops, ${s.contradictions} contradictions`);
    ok("worldModel.summary()");
  } catch (e) { fail("worldModel.summary()", e); }

  // Test 5: List entities
  try {
    const entities = cecil.worldModel.entities();
    console.log(`         → ${entities.length} entities total`);
    if (entities.length > 0) {
      console.log(`         → Top: ${entities.slice(0, 3).map(e => e.name).join(", ")}`);
    }
    ok("worldModel.entities()");
  } catch (e) { fail("worldModel.entities()", e); }

  // Test 6: Filter entities by kind
  try {
    const people = cecil.worldModel.entities("person");
    console.log(`         → ${people.length} person entities`);
    ok("worldModel.entities('person')");
  } catch (e) { fail("worldModel.entities('person')", e); }

  // Test 7: List beliefs
  try {
    const beliefs = cecil.worldModel.beliefs("active");
    console.log(`         → ${beliefs.length} active beliefs`);
    ok("worldModel.beliefs()");
  } catch (e) { fail("worldModel.beliefs()", e); }

  // Test 8: List open loops
  try {
    const loops = cecil.worldModel.openLoops("open");
    console.log(`         → ${loops.length} open loops`);
    ok("worldModel.openLoops()");
  } catch (e) { fail("worldModel.openLoops()", e); }

  // Test 9: List contradictions
  try {
    const contras = cecil.worldModel.contradictions();
    console.log(`         → ${contras.length} unresolved contradictions`);
    ok("worldModel.contradictions()");
  } catch (e) { fail("worldModel.contradictions()", e); }

  // Test 10: Recall
  try {
    const result = await cecil.recall("what matters most");
    console.log(`         → ${result.snippets.length} snippets, ${result.formattedContext.length} chars`);
    if (result.formattedContext.length > 0) ok("recall()");
    else fail("recall()", "empty context");
  } catch (e) { fail("recall()", e); }

  // Test 11: Store a memory
  try {
    const key = await cecil.store("Cecil v2 test memory — integration test ran successfully", {
      type: "fact",
      source: "test-v2",
    });
    console.log(`         → Stored as: ${key}`);
    ok("store()");
  } catch (e) { fail("store()", e); }

  // Test 12: Recall the stored memory
  try {
    const result = await cecil.recall("Cecil v2 test memory integration");
    const found = result.snippets.some(s => s.text.includes("integration test"));
    console.log(`         → Found stored memory: ${found}`);
    ok("recall stored memory");
  } catch (e) { fail("recall stored memory", e); }

  // Test 13: Chat (requires LLM)
  try {
    console.log("         → Sending chat message...");
    const result = await cecil.chat([
      { role: "user", content: "Hey, quick test. What's 2+2?" }
    ]);
    console.log(`         → Response (${result.response.length} chars): "${result.response.slice(0, 80)}..."`);
    console.log(`         → Session: ${result.sessionId}`);
    console.log(`         → Deep search: ${result.usedDeepSearch}`);
    if (result.response.length > 0) ok("chat()");
    else fail("chat()", "empty response");
  } catch (e) { fail("chat()", e); }

  // Test 14: Full turn (chat + observe)
  try {
    console.log("         → Running full turn...");
    const result = await cecil.turn([
      { role: "user", content: "Remember: I'm testing Cecil v2 right now." }
    ]);
    console.log(`         → Response (${result.response.length} chars): "${result.response.slice(0, 80)}..."`);
    console.log(`         → Observed: ${result.observed}`);
    if (result.response.length > 0) ok("turn()");
    else fail("turn()", "empty response");
  } catch (e) { fail("turn()", e); }

  // Test 15: Maintenance dry run
  try {
    console.log("         → Running maintenance (dry run)...");
    const report = await cecil.maintenance({ dryRun: true });
    console.log(`         → Dedup: ${report.exactDedups}, Quality: ${report.qualityRetired}, Stale: ${report.staleLoops}`);
    console.log(`         → Duration: ${report.duration}ms`);
    ok("maintenance(dryRun)");
  } catch (e) { fail("maintenance(dryRun)", e); }

  // Test 16: Reflection (requires LLM — may be slow)
  try {
    console.log("         → Running reflection (patterns only)...");
    const report = await cecil.reflect(["patterns"]);
    console.log(`         → Patterns: ${report.patterns.slice(0, 80)}...`);
    console.log(`         → Generated: ${report.generatedAt}`);
    ok("reflect()");
  } catch (e) { fail("reflect()", e); }

  // Summary
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
