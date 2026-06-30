import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, type Db, type Clock } from "./sqlite.js";
import { SqliteResponseCache, hashPrompt } from "./responseCache.js";

function makeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("hashPrompt", () => {
  it("is stable across whitespace and key-order differences", () => {
    const a = hashPrompt({ model: "sonnet", description: "build  a\n  queue" });
    const b = hashPrompt({ description: "build a queue", model: "sonnet" });
    expect(a).toBe(b);
  });

  it("differs for logically different prompts", () => {
    const a = hashPrompt({ description: "build a queue" });
    const b = hashPrompt({ description: "build a cache" });
    expect(a).not.toBe(b);
  });

  it("normalizes whitespace inside nested arrays/strings", () => {
    const a = hashPrompt({ answers: ["yes   please", "  no  "] });
    const b = hashPrompt({ answers: ["yes please", "no"] });
    expect(a).toBe(b);
  });
});

describe("SqliteResponseCache", () => {
  let db: Db;
  let cache: SqliteResponseCache;
  let clock: ReturnType<typeof makeClock>;
  const TTL = 1_000;

  beforeEach(() => {
    db = openTempDb();
    clock = makeClock(10_000);
    cache = new SqliteResponseCache(db, clock);
  });

  it("returns a hit within TTL", async () => {
    await cache.set("h1", "{body}");
    const hit = await cache.get("h1", TTL);
    expect(hit).toEqual({ promptHash: "h1", body: "{body}", createdAt: 10_000 });
  });

  it("returns undefined for an unknown hash", async () => {
    expect(await cache.get("missing", TTL)).toBeUndefined();
  });

  it("returns undefined once now - createdAt exceeds TTL", async () => {
    await cache.set("h1", "{body}");
    clock.advance(TTL + 1);
    expect(await cache.get("h1", TTL)).toBeUndefined();
  });

  it("set overwrites body and refreshes createdAt", async () => {
    await cache.set("h1", "old");
    clock.advance(500);
    await cache.set("h1", "new");
    const hit = await cache.get("h1", TTL);
    expect(hit?.body).toBe("new");
    expect(hit?.createdAt).toBe(10_500);
  });
});
