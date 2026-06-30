/**
 * DynamoDB-backed identical-prompt response cache (KTD7). `set` writes a native TTL
 * attribute (`expiresAt`, epoch seconds) so DynamoDB reaps stale entries on its own;
 * `get` still honors the caller's per-call TTL because native TTL deletion lags up to
 * ~48h — the in-read check is the correctness guarantee, the attribute is just GC.
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import type { ResponseCache, CachedResponse } from "../types.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { DynamoDeps } from "./client.js";

interface CacheItem {
  promptHash: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export class DynamoResponseCache implements ResponseCache {
  constructor(
    private readonly deps: DynamoDeps,
    private readonly clock: Clock = systemClock,
    /** TTL for the native `expiresAt` attribute (config.RESPONSE_CACHE_TTL_MS). */
    private readonly ttlMs: number = 86_400_000,
  ) {}

  async get(promptHash: string, ttlMs: number): Promise<CachedResponse | undefined> {
    const res = await this.deps.doc.send(
      new GetCommand({ TableName: this.deps.table("responseCache"), Key: { promptHash } }),
    );
    const item = res.Item as CacheItem | undefined;
    if (!item) return undefined;
    if (this.clock.now() - item.createdAt > ttlMs) return undefined;
    return { promptHash: item.promptHash, body: item.body, createdAt: item.createdAt };
  }

  async set(promptHash: string, body: string): Promise<void> {
    const createdAt = this.clock.now();
    const item: CacheItem = {
      promptHash,
      body,
      createdAt,
      expiresAt: Math.floor((createdAt + this.ttlMs) / 1000),
    };
    await this.deps.doc.send(
      new PutCommand({ TableName: this.deps.table("responseCache"), Item: item }),
    );
  }
}
