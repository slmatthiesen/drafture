/**
 * SQLite-backed identical-prompt response cache (KTD7). `get` honors a per-call
 * TTL so an expired entry is invisible without a sweep job.
 */
import { createHash } from "node:crypto";

import type { ResponseCache, CachedResponse } from "./types.js";
import type { Db, Clock } from "./sqlite.js";
import { systemClock } from "./sqlite.js";

interface CacheRow {
  prompt_hash: string;
  body: string;
  created_at: number;
}

/**
 * Stable SHA-256 over deterministically-serialized input: object keys are
 * sorted and whitespace inside strings is collapsed/trimmed, so logically
 * identical prompts (different key order or formatting) hash equal. This is the
 * cache key — drift here silently busts the cache (prompt-caching invalidator).
 */
export function hashPrompt(parts: unknown): string {
  return createHash("sha256").update(canonicalize(parts)).digest("hex");
}

function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = normalize(source[key]);
    }
    return out;
  }
  return value;
}

export class SqliteResponseCache implements ResponseCache {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(promptHash: string, ttlMs: number): Promise<CachedResponse | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM response_cache WHERE prompt_hash = ?`)
      .get(promptHash) as CacheRow | undefined;
    if (!row) return undefined;
    if (this.clock.now() - row.created_at > ttlMs) return undefined;
    return {
      promptHash: row.prompt_hash,
      body: row.body,
      createdAt: row.created_at,
    };
  }

  async set(promptHash: string, body: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO response_cache (prompt_hash, body, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(prompt_hash) DO UPDATE SET
           body = excluded.body,
           created_at = excluded.created_at`,
      )
      .run(promptHash, body, this.clock.now());
  }
}
