/**
 * Delete all extracted facts for Unfiltered episodes 1-21 from Qdrant.
 * Preserves interview facts (alpha-pod, nft-catcher, etc.).
 *
 * Usage: npx tsx scripts/delete-episode-facts.ts
 *
 * Run this BEFORE re-extracting facts from diarized transcripts.
 * Requires Qdrant running at localhost:6333.
 */

import { getQdrantClient, COLLECTION_NAME, initCollection } from "../cecil/embedder";

async function main() {
  await initCollection();
  const client = getQdrantClient();

  console.log(`Deleting facts for episodes 1-21 from collection: ${COLLECTION_NAME}\n`);

  let totalDeleted = 0;

  for (let ep = 1; ep <= 21; ep++) {
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
