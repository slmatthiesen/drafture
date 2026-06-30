/**
 * SQLite-backed PricingStore keyed by (service, region) (KTD6). `get` returns
 * the rows of the freshest month present for a (service, region); the monthly
 * refresh swaps a month's snapshot atomically; `seed` lays down offline-fallback
 * facts without clobbering a fresher month already cached.
 */
import type { PricingStore, PriceRecord } from "./types.js";
import type { Db } from "./sqlite.js";

interface PricingRow {
  service: string;
  region: string;
  unit: string;
  usd: number;
  month: string;
  note: string;
}

function toRecord(row: PricingRow): PriceRecord {
  return {
    service: row.service,
    region: row.region,
    unit: row.unit,
    usd: row.usd,
    month: row.month,
    note: row.note,
  };
}

export class SqlitePricingStore implements PricingStore {
  constructor(private readonly db: Db) {}

  async get(service: string, region: string): Promise<PriceRecord[]> {
    // YYYY-MM sorts lexicographically, so MAX(month) is the freshest snapshot.
    const rows = this.db
      .prepare(
        `SELECT * FROM pricing
         WHERE service = ? AND region = ?
           AND month = (
             SELECT MAX(month) FROM pricing WHERE service = ? AND region = ?
           )
         ORDER BY unit ASC`,
      )
      .all(service, region, service, region) as PricingRow[];
    return rows.map(toRecord);
  }

  async replaceMonth(region: string, month: string, records: PriceRecord[]): Promise<void> {
    const swap = this.db.transaction((rows: PriceRecord[]) => {
      this.db
        .prepare(`DELETE FROM pricing WHERE region = ? AND month = ?`)
        .run(region, month);
      const insert = this.db.prepare(
        `INSERT INTO pricing (service, region, unit, usd, month, note)
         VALUES (@service, @region, @unit, @usd, @month, @note)`,
      );
      for (const r of rows) insert.run(r);
    });
    swap.immediate(records);
  }

  async seed(records: PriceRecord[]): Promise<void> {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO pricing (service, region, unit, usd, month, note)
       VALUES (@service, @region, @unit, @usd, @month, @note)`,
    );
    const hasFresher = this.db.prepare(
      `SELECT 1 FROM pricing WHERE service = ? AND region = ? AND month >= ? LIMIT 1`,
    );
    const run = this.db.transaction((rows: PriceRecord[]) => {
      for (const r of rows) {
        // Skip if a same-or-newer month is already cached for this key.
        if (hasFresher.get(r.service, r.region, r.month)) continue;
        insert.run(r);
      }
    });
    run.immediate(records);
  }
}
