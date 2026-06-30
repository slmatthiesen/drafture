/**
 * Storage backend selector (the swap point, KTD5). Routes/pipeline depend only on the
 * `Stores` interfaces; this picks the concrete backend from `STORE_BACKEND`:
 * SQLite (dev/test, default) or DynamoDB (serverless prod). Provider-abstracted,
 * factory-selected — the house style.
 */
import type { Config } from "../config.js";
import type { Stores } from "./types.js";
import { systemClock } from "./clock.js";
import { getDb, createStores, type Db } from "./sqlite.js";

import { makeDynamoDeps, dynamoConfigFromAppConfig } from "./dynamo/client.js";
import { DynamoMemoryStore } from "./dynamo/memory.js";
import { DynamoResponseCache } from "./dynamo/responseCache.js";
import { DynamoPricingStore } from "./dynamo/pricing.js";
import { DynamoSpendLedger } from "./dynamo/spendLedger.js";
import { DynamoCuratedStore } from "./dynamo/curated.js";
import { DynamoFeedbackStore } from "./dynamo/feedback.js";
import { DynamoGenerationsStore } from "./dynamo/generations.js";
import { DynamoDesignVectorStore } from "./dynamo/designVectors.js";

/** Construct the DynamoDB-backed stores from config (serverless prod backend). */
export function createDynamoStores(config: Config): Stores {
  const deps = makeDynamoDeps(dynamoConfigFromAppConfig(config));
  return {
    memory: new DynamoMemoryStore(deps),
    responseCache: new DynamoResponseCache(deps, systemClock, config.RESPONSE_CACHE_TTL_MS),
    pricing: new DynamoPricingStore(deps),
    spendLedger: new DynamoSpendLedger(deps),
    curated: new DynamoCuratedStore(deps),
    feedback: new DynamoFeedbackStore(deps),
    generations: new DynamoGenerationsStore(deps),
    designVectors: new DynamoDesignVectorStore(deps),
  };
}

export interface BuiltStores {
  stores: Stores;
  /** The owned SQLite handle when that backend was selected; undefined for DynamoDB. */
  db?: Db;
}

/** Select + construct the storage backend from config (`STORE_BACKEND`). */
export function buildStores(config: Config): BuiltStores {
  if (config.STORE_BACKEND === "dynamodb") {
    return { stores: createDynamoStores(config) };
  }
  const db = getDb(config.DB_PATH);
  return { stores: createStores(db), db };
}
