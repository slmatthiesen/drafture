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

  it("upsert then get returns the stored doc", () => {
    const saved = store.upsert(baseDoc);
    expect(saved.createdAt).toBe(1_000);
    expect(saved.updatedAt).toBe(1_000);
    expect(store.get(baseDoc.topic)).toEqual(saved);
    expect(store.getById(baseDoc.id)).toEqual(saved);
  });

  it("second upsert overwrites and preserves createdAt while bumping updatedAt", () => {
    store.upsert(baseDoc);
    clock.advance(500);
    const updated = store.upsert({ ...baseDoc, fact: "Updated fact." });
    expect(updated.fact).toBe("Updated fact.");
    expect(updated.createdAt).toBe(1_000); // preserved
    expect(updated.updatedAt).toBe(1_500); // bumped
    expect(store.get(baseDoc.topic)?.fact).toBe("Updated fact.");
  });

  it("search returns verified and quarantined docs for matching topics", () => {
    store.upsert(baseDoc);
    store.upsert({
      ...baseDoc,
      id: "doc-2",
      topic: "nat-gateway-cost",
      verified: false,
      provenance: "research",
    });
    const hits = store.search(["s3-block-public-access", "nat-gateway-cost"]);
    expect(hits.map((d) => d.id).sort()).toEqual(["doc-1", "doc-2"]);
    expect(store.search([])).toEqual([]);
    expect(store.search(["nonexistent"])).toEqual([]);
  });

  it("listPending returns only unverified docs", () => {
    store.upsert(baseDoc);
    store.upsert({ ...baseDoc, id: "doc-2", verified: false, provenance: "research" });
    const pending = store.listPending();
    expect(pending.map((d) => d.id)).toEqual(["doc-2"]);
  });

  it("setVerified flips the flag and reports whether a row matched", () => {
    store.upsert({ ...baseDoc, verified: false, provenance: "research" });
    expect(store.setVerified("doc-1", true)).toBe(true);
    expect(store.getById("doc-1")?.verified).toBe(true);
    expect(store.setVerified("missing", true)).toBe(false);
  });

  it("delete removes a doc and reports whether a row matched", () => {
    store.upsert(baseDoc);
    expect(store.delete("doc-1")).toBe(true);
    expect(store.getById("doc-1")).toBeUndefined();
    expect(store.delete("doc-1")).toBe(false);
  });
});
