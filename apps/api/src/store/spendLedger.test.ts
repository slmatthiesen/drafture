import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, type Db, type Clock } from "./sqlite.js";
import { SqliteSpendLedger } from "./spendLedger.js";

const DAY_MS = 86_400_000;
// 2026-06-26T12:00:00Z — noon so +1 day stays within the same calendar logic.
const DAY1 = Date.parse("2026-06-26T12:00:00Z");

function makeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("SqliteSpendLedger — reservations", () => {
  let db: Db;
  let ledger: SqliteSpendLedger;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    db = openTempDb();
    clock = makeClock(DAY1);
    ledger = new SqliteSpendLedger(db, clock);
  });

  it("reserves while under the ceiling and reports running total", () => {
    const r = ledger.reserve(0.3, 1.0);
    expect(r.ok).toBe(true);
    expect(r.spentTodayUsd).toBeCloseTo(0.3);
    expect(ledger.spentTodayUsd()).toBeCloseTo(0.3);
  });

  it("reconcile replaces the provisional amount with the actual", () => {
    const r = ledger.reserve(0.3, 1.0);
    ledger.reconcile(r.reservationId, 0.5);
    expect(ledger.spentTodayUsd()).toBeCloseTo(0.5);
  });

  it("release removes a reservation's debit", () => {
    const r = ledger.reserve(0.3, 1.0);
    ledger.release(r.reservationId);
    expect(ledger.spentTodayUsd()).toBeCloseTo(0);
  });

  it("reserve-on-entry does not overshoot the ceiling under repeated entry", () => {
    // better-sqlite3 serializes writers; each reserve re-reads today's sum inside
    // an IMMEDIATE txn, so once the budget is exhausted the rest must fail.
    const ceiling = 1.0;
    const per = 0.3;
    let successes = 0;
    for (let i = 0; i < 20; i++) {
      if (ledger.reserve(per, ceiling).ok) successes++;
    }
    expect(successes).toBe(3); // 0.9 fits, 1.2 would overshoot
    expect(ledger.spentTodayUsd()).toBeLessThanOrEqual(ceiling);
    expect(ledger.spentTodayUsd()).toBeCloseTo(0.9);
  });

  it("a rejected reserve reports the unchanged spend and no reservation id", () => {
    ledger.reserve(0.9, 1.0);
    const r = ledger.reserve(0.5, 1.0);
    expect(r.ok).toBe(false);
    expect(r.reservationId).toBe("");
    expect(r.spentTodayUsd).toBeCloseTo(0.9);
  });

  it("sums only today's rows across a day boundary", () => {
    ledger.reserve(0.5, 5.0);
    expect(ledger.spentTodayUsd()).toBeCloseTo(0.5);
    clock.advance(DAY_MS); // cross into the next UTC day
    expect(ledger.spentTodayUsd()).toBeCloseTo(0); // prior day excluded
    ledger.reserve(0.2, 5.0);
    expect(ledger.spentTodayUsd()).toBeCloseTo(0.2);
  });
});

describe("SqliteSpendLedger — per-IP daily counts", () => {
  let db: Db;
  let ledger: SqliteSpendLedger;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    db = openTempDb();
    clock = makeClock(DAY1);
    ledger = new SqliteSpendLedger(db, clock);
  });

  it("increments per IP and isolates IPs", () => {
    expect(ledger.incrementIpCount("1.1.1.1")).toBe(1);
    expect(ledger.incrementIpCount("1.1.1.1")).toBe(2);
    expect(ledger.ipCountToday("1.1.1.1")).toBe(2);
    expect(ledger.ipCountToday("2.2.2.2")).toBe(0);
  });

  it("resets the count across a day boundary", () => {
    ledger.incrementIpCount("1.1.1.1");
    ledger.incrementIpCount("1.1.1.1");
    clock.advance(DAY_MS);
    expect(ledger.ipCountToday("1.1.1.1")).toBe(0);
    expect(ledger.incrementIpCount("1.1.1.1")).toBe(1);
  });
});
