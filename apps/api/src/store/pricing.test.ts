import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";

import { getDb, tempDbPath, type Db } from "./sqlite.js";
import { SqlitePricingStore } from "./pricing.js";
import type { PriceRecord } from "./types.js";

function record(over: Partial<PriceRecord>): PriceRecord {
  return {
    service: "Lambda",
    region: "us-east-1",
    unit: "per-1k-requests",
    usd: 0.2,
    month: "2026-06",
    note: "on-demand list price",
    ...over,
  };
}

function rmDb(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      rmSync(p);
    } catch {
      // already gone
    }
  }
}

describe("SqlitePricingStore", () => {
  // Exercise the real on-disk path (WAL) and clean up temp files.
  let path: string;
  let db: Db;
  let store: SqlitePricingStore;

  beforeEach(() => {
    path = tempDbPath();
    db = getDb(path);
    store = new SqlitePricingStore(db);
  });

  afterEach(() => {
    db.close();
    rmDb(path);
  });

  it("reads/writes keyed by (service, region)", () => {
    store.replaceMonth("us-east-1", "2026-06", [
      record({ service: "Lambda", region: "us-east-1", unit: "per-1k-requests", usd: 0.2 }),
      record({ service: "Lambda", region: "us-east-1", unit: "gb-second", usd: 0.0000167 }),
      record({ service: "Lambda", region: "eu-west-1", unit: "per-1k-requests", usd: 0.23 }),
    ]);
    const usEast = store.get("Lambda", "us-east-1");
    expect(usEast).toHaveLength(2);
    const euWest = store.get("Lambda", "eu-west-1");
    expect(euWest).toHaveLength(1);
    expect(euWest[0]?.usd).toBe(0.23);
    expect(store.get("Lambda", "ap-south-1")).toEqual([]);
  });

  it("replaceMonth atomically removes the prior rows for that (region, month)", () => {
    store.replaceMonth("us-east-1", "2026-06", [
      record({ unit: "per-1k-requests", usd: 0.2 }),
      record({ unit: "gb-second", usd: 0.0000167 }),
    ]);
    // Refresh the same month with a different shape — old rows must be gone.
    store.replaceMonth("us-east-1", "2026-06", [
      record({ unit: "per-1k-requests", usd: 0.25 }),
    ]);
    const rows = store.get("Lambda", "us-east-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usd).toBe(0.25);
  });

  it("get returns only the freshest month when multiple months coexist", () => {
    store.replaceMonth("us-east-1", "2026-05", [record({ month: "2026-05", usd: 0.18 })]);
    store.replaceMonth("us-east-1", "2026-06", [record({ month: "2026-06", usd: 0.2 })]);
    const rows = store.get("Lambda", "us-east-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.month).toBe("2026-06");
    expect(rows[0]?.usd).toBe(0.2);
  });

  it("seed does not clobber a fresher cached month and is idempotent", () => {
    store.replaceMonth("us-east-1", "2026-06", [record({ month: "2026-06", usd: 0.2 })]);
    store.seed([record({ month: "2026-01", usd: 0.99 })]); // stale fallback
    expect(store.get("Lambda", "us-east-1")[0]?.usd).toBe(0.2);

    // Seeding into an empty key works and re-seeding does not duplicate.
    store.seed([record({ service: "S3", month: "2026-01", usd: 0.4 })]);
    store.seed([record({ service: "S3", month: "2026-01", usd: 0.4 })]);
    expect(store.get("S3", "us-east-1")).toHaveLength(1);
  });
});
