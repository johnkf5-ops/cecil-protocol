import { synthesizePodcasts } from "../cecil/podcast-observer";

async function main(): Promise<void> {
  const result = await synthesizePodcasts();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
