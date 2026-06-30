import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, type Db, type Clock } from "./sqlite.js";
import { SqliteMemoryStore } from "./memory.js";

function makeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const baseDoc = {
  id: "doc-1",
  topic: "s3-block-public-access",
  fact: "Enable account-level Block Public Access on S3.",
  rationale: "Prevents accidental public exposure of buckets.",
  source: "https://docs.aws.amazon.com/",
  verified: true,
  provenance: "seed" as const,
};

describe("SqliteMemoryStore", () => {
  let db: Db;
  let store: SqliteMemoryStore;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    db = openTempDb();
    clock = makeClock(1_000);
    store = new SqliteMemoryStore(db, clock);
  });

  it("upsert then get returns the stored doc", async () => {
    const saved = await store.upsert(baseDoc);
    expect(saved.createdAt).toBe(1_000);
    expect(saved.updatedAt).toBe(1_000);
    expect(await store.get(baseDoc.topic)).toEqual(saved);
    expect(await store.getById(baseDoc.id)).toEqual(saved);
  });

  it("second upsert overwrites and preserves createdAt while bumping updatedAt", async () => {
    await store.upsert(baseDoc);
    clock.advance(500);
    const updated = await store.upsert({ ...baseDoc, fact: "Updated fact." });
    expect(updated.fact).toBe("Updated fact.");
    expect(updated.createdAt).toBe(1_000); // preserved
    expect(updated.updatedAt).toBe(1_500); // bumped
    expect((await store.get(baseDoc.topic))?.fact).toBe("Updated fact.");
  });

  it("search returns verified and quarantined docs for matching topics", async () => {
    await store.upsert(baseDoc);
    await store.upsert({
      ...baseDoc,
      id: "doc-2",
      topic: "nat-gateway-cost",
      verified: false,
      provenance: "research",
    });
    const hits = await store.search(["s3-block-public-access", "nat-gateway-cost"]);
    expect(hits.map((d) => d.id).sort()).toEqual(["doc-1", "doc-2"]);
    expect(await store.search([])).toEqual([]);
    expect(await store.search(["nonexistent"])).toEqual([]);
  });

  it("listPending returns only unverified docs", async () => {
    await store.upsert(baseDoc);
    await store.upsert({ ...baseDoc, id: "doc-2", verified: false, provenance: "research" });
    const pending = await store.listPending();
    expect(pending.map((d) => d.id)).toEqual(["doc-2"]);
  });

  it("setVerified flips the flag and reports whether a row matched", async () => {
    await store.upsert({ ...baseDoc, verified: false, provenance: "research" });
    expect(await store.setVerified("doc-1", true)).toBe(true);
    expect((await store.getById("doc-1"))?.verified).toBe(true);
    expect(await store.setVerified("missing", true)).toBe(false);
  });

  it("delete removes a doc and reports whether a row matched", async () => {
    await store.upsert(baseDoc);
    expect(await store.delete("doc-1")).toBe(true);
    expect(await store.getById("doc-1")).toBeUndefined();
    expect(await store.delete("doc-1")).toBe(false);
  });
});
