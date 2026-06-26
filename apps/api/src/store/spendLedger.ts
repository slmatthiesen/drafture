/**
 * SQLite-backed SpendLedger (KTD7/KTD8). Reserve-on-entry is transactional: the
 * ceiling check (sum of today's reconciled actuals + outstanding reservations)
 * and the provisional insert run inside one IMMEDIATE transaction, so concurrent
 * callers cannot each pass and overshoot the ceiling — better-sqlite3 serializes
 * writers, and BEGIN IMMEDIATE takes the write lock before the read.
 *
 * Today's spend is simply SUM(amount_usd) for today's day bucket: a provisional
 * row contributes its provisional amount until `reconcile` replaces it with the
 * actual; `release` deletes it. The UTC day bucket is derived from the injected
 * clock so day-boundary behavior is testable.
 */
import { randomUUID } from "node:crypto";

import type { SpendLedger, SpendReservation } from "./types.js";
import type { Db, Clock } from "./sqlite.js";
import { systemClock, utcDayKey } from "./sqlite.js";

interface SumRow {
  total: number | null;
}

interface CountRow {
  count: number;
}

export class SqliteSpendLedger implements SpendLedger {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  private today(): string {
    return utcDayKey(this.clock.now());
  }

  private sumForDay(day: string): number {
    const row = this.db
      .prepare(`SELECT SUM(amount_usd) AS total FROM spend_entries WHERE day = ?`)
      .get(day) as SumRow;
    return row.total ?? 0;
  }

  reserve(provisionalUsd: number, ceilingUsd: number): SpendReservation {
    const day = this.today();
    const now = this.clock.now();
    const txn = this.db.transaction((): SpendReservation => {
      const spent = this.sumForDay(day);
      if (spent + provisionalUsd > ceilingUsd) {
        return {
          ok: false,
          reservationId: "",
          spentTodayUsd: spent,
          ceilingUsd,
        };
      }
      const reservationId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO spend_entries (id, day, amount_usd, status, created_at)
           VALUES (?, ?, ?, 'provisional', ?)`,
        )
        .run(reservationId, day, provisionalUsd, now);
      return {
        ok: true,
        reservationId,
        spentTodayUsd: spent + provisionalUsd,
        ceilingUsd,
      };
    });
    return txn.immediate();
  }

  reconcile(reservationId: string, actualUsd: number): void {
    this.db
      .prepare(
        `UPDATE spend_entries SET amount_usd = ?, status = 'reconciled' WHERE id = ?`,
      )
      .run(actualUsd, reservationId);
  }

  release(reservationId: string): void {
    this.db
      .prepare(`DELETE FROM spend_entries WHERE id = ?`)
      .run(reservationId);
  }

  spentTodayUsd(): number {
    return this.sumForDay(this.today());
  }

  incrementIpCount(ip: string): number {
    const day = this.today();
    const txn = this.db.transaction((): number => {
      this.db
        .prepare(
          `INSERT INTO ip_counts (ip, day, count) VALUES (?, ?, 1)
           ON CONFLICT(ip, day) DO UPDATE SET count = count + 1`,
        )
        .run(ip, day);
      const row = this.db
        .prepare(`SELECT count FROM ip_counts WHERE ip = ? AND day = ?`)
        .get(ip, day) as CountRow;
      return row.count;
    });
    return txn.immediate();
  }

  ipCountToday(ip: string): number {
    const row = this.db
      .prepare(`SELECT count FROM ip_counts WHERE ip = ? AND day = ?`)
      .get(ip, this.today()) as CountRow | undefined;
    return row?.count ?? 0;
  }
}
