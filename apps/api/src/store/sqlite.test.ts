import { describe, it, expect } from "vitest";

import { getDb, openTempDb, createStores, utcDayKey } from "./sqlite.js";

interface NameRow {
  name: string;
}

describe("sqlite boot", () => {
  it("migrations are idempotent — a second getDb on the same file does not error", () => {
    const db1 = openTempDb();
    // Re-running migrations on an already-migrated connection is a no-op.
    expect(() => getDb(":memory:")).not.toThrow();
    const tables = db1
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as NameRow[];
    const names = tables.map((t) => t.name);
    for (const expected of ["memory_docs", "response_cache", "pricing", "spend_entries", "ip_counts"]) {
      expect(names).toContain(expected);
    }
  });

  it("createStores wires all four stores against one db", () => {
    const db = openTempDb();
    const stores = createStores(db);
    expect(stores.memory).toBeDefined();
    expect(stores.responseCache).toBeDefined();
    expect(stores.pricing).toBeDefined();
    expect(stores.spendLedger).toBeDefined();
  });

  it("utcDayKey buckets by UTC calendar day", () => {
    expect(utcDayKey(Date.parse("2026-06-26T23:59:59Z"))).toBe("2026-06-26");
    expect(utcDayKey(Date.parse("2026-06-27T00:00:00Z"))).toBe("2026-06-27");
  });
});
