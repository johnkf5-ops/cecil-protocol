import { QdrantClient } from "@qdrant/js-client-rest";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import { v4 as uuidv4 } from "uuid";
import type { MemoryMetadata } from "./types";

const COLLECTION_NAME = "cecil_memory";
const VECTOR_SIZE = 384;

let embeddingModel: FlagEmbedding | null = null;
let qdrantClient: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!qdrantClient) {
    qdrantClient = new QdrantClient({
      url: process.env.QDRANT_URL || "http://localhost:6333",
    });
  }
  return qdrantClient;
}

async function getEmbeddingModel(): Promise<FlagEmbedding> {
  if (!embeddingModel) {
    embeddingModel = await FlagEmbedding.init({
      model: EmbeddingModel.AllMiniLML6V2,
    });
  }
  return embeddingModel;
}

export async function initCollection(): Promise<void> {
  const client = getQdrantClient();
  const collections = await client.getCollections();
  const exists = collections.collections.some(
    (c) => c.name === COLLECTION_NAME
  );

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: "type",
      field_schema: "keyword",
    });
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: "timestamp",
      field_schema: "keyword",
    });
  }

  // Ensure sourceEpisode index exists (idempotent — safe on existing collection)
  try {
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: "sourceEpisode",
      field_schema: "keyword",
    });
  } catch {
    // Index already exists — ignore
  }
}

async function embedText(text: string): Promise<number[]> {
  const model = await getEmbeddingModel();
  const embeddings = model.embed([text], 1);
  for await (const batch of embeddings) {
    return Array.from(batch[0]);
  }
  throw new Error("Failed to generate embedding");
}

export async function embed(
  text: string,
  metadata: MemoryMetadata
): Promise<string> {
  const client = getQdrantClient();
  const vector = await embedText(text);
  const id = uuidv4();

  await client.upsert(COLLECTION_NAME, {
    points: [
      {
        id,
        vector,
        payload: {
          ...metadata,
          text,
        },
      },
    ],
  });

  return id;
}

export async function embedBatch(
  items: { text: string; metadata: MemoryMetadata }[]
): Promise<string[]> {
  if (items.length === 0) return [];

  const client = getQdrantClient();
  const model = await getEmbeddingModel();
  const texts = items.map((i) => i.text);
  const allVectors: number[][] = [];

  const embeddings = model.embed(texts, 256);
  for await (const batch of embeddings) {
    for (const vec of batch) {
      allVectors.push(Array.from(vec));
    }
  }

  const ids = items.map(() => uuidv4());

  await client.upsert(COLLECTION_NAME, {
    points: ids.map((id, i) => ({
      id,
      vector: allVectors[i],
      payload: {
        ...items[i].metadata,
        text: items[i].text,
      },
    })),
  });

  return ids;
}

export { embedText, COLLECTION_NAME };
