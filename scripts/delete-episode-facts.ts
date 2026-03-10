/**
 * Delete all extracted facts for a range of episodes from Qdrant.
 * Preserves interview facts unless explicitly targeted.
 *
 * Usage: npx tsx scripts/delete-episode-facts.ts [startEp] [endEp]
 *   e.g. npx tsx scripts/delete-episode-facts.ts 1 21
 *
 * Run this BEFORE re-extracting facts from diarized transcripts.
 * Requires Qdrant running at localhost:6333.
 */

import { getQdrantClient, COLLECTION_NAME, initCollection } from "../cecil/embedder";

async function main() {
  const startEp = parseInt(process.argv[2] || "1", 10);
  const endEp = parseInt(process.argv[3] || String(startEp), 10);

  if (isNaN(startEp) || isNaN(endEp) || startEp < 1 || endEp < startEp) {
    console.error("Usage: npx tsx scripts/delete-episode-facts.ts [startEp] [endEp]");
    process.exit(1);
  }

  await initCollection();
  const client = getQdrantClient();

  console.log(`Deleting facts for episodes ${startEp}-${endEp} from collection: ${COLLECTION_NAME}\n`);

  let totalDeleted = 0;

  for (let ep = startEp; ep <= endEp; ep++) {
    const label = `episode-${ep}`;

    // Count before delete
    const countResult = await client.count(COLLECTION_NAME, {
      filter: {
        must: [
          { key: "type", match: { value: "fact" } },
          { key: "sourceEpisode", match: { value: label } },
        ],
      },
      exact: true,
    });

    const count = countResult.count;
    if (count === 0) {
      console.log(`  ${label}: 0 facts (skipped)`);
      continue;
    }

    await client.delete(COLLECTION_NAME, {
      filter: {
        must: [
          { key: "type", match: { value: "fact" } },
          { key: "sourceEpisode", match: { value: label } },
        ],
      },
    });

    console.log(`  ${label}: ${count} facts deleted`);
    totalDeleted += count;
  }

  console.log(`\nTotal deleted: ${totalDeleted} facts`);
  console.log("Interview facts preserved.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
