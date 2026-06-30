/**
 * DynamoDB-backed PricingStore. PK=`service#region`, SK=`month#unit`, so `get` is a
 * single Query by PK (then pick the freshest month in app — a handful of rows). A
 * `regionMonth-index` GSI (PK `region#month`) lets `replaceMonth` find a month's rows
 * to delete. `replaceMonth` is delete-then-put in batches (not a transaction): a reader
 * mid-refresh may briefly see a partial month — acceptable for a monthly offline job
 * (plan §3), and `get` always prefers the highest complete month present.
 */
import { QueryCommand, BatchWriteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import type { PricingStore, PriceRecord } from "../types.js";
import type { DynamoDeps } from "./client.js";

interface PricingItem {
  pk: string;
  sk: string;
  regionMonth: string;
  service: string;
  region: string;
  unit: string;
  usd: number;
  month: string;
  note: string;
}

function pk(service: string, region: string): string {
  return `${service}#${region}`;
}

function toItem(r: PriceRecord): PricingItem {
  return {
    pk: pk(r.service, r.region),
    sk: `${r.month}#${r.unit}`,
    regionMonth: `${r.region}#${r.month}`,
    service: r.service,
    region: r.region,
    unit: r.unit,
    usd: r.usd,
    month: r.month,
    note: r.note,
  };
}

function toRecord(item: PricingItem): PriceRecord {
  return {
    service: item.service,
    region: item.region,
    unit: item.unit,
    usd: item.usd,
    month: item.month,
    note: item.note,
  };
}

/** DynamoDB BatchWrite caps at 25 items/request. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class DynamoPricingStore implements PricingStore {
  constructor(private readonly deps: DynamoDeps) {}

  private get table(): string {
    return this.deps.table("pricing");
  }

  async get(service: string, region: string): Promise<PriceRecord[]> {
    const res = await this.deps.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk(service, region) },
      }),
    );
    const items = (res.Items ?? []) as PricingItem[];
    if (items.length === 0) return [];
    // YYYY-MM sorts lexicographically; pick the freshest month's rows only.
    const maxMonth = items.reduce((m, it) => (it.month > m ? it.month : m), items[0]!.month);
    return items
      .filter((it) => it.month === maxMonth)
      .map(toRecord)
      .sort((a, b) => a.unit.localeCompare(b.unit));
  }

  async replaceMonth(region: string, month: string, records: PriceRecord[]): Promise<void> {
    // Find the existing rows for this region+month (keys only) and delete them.
    const existing = await this.deps.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "regionMonth-index",
        KeyConditionExpression: "regionMonth = :rm",
        ExpressionAttributeValues: { ":rm": `${region}#${month}` },
      }),
    );
    const deletes = (existing.Items ?? []).map((it) => ({
      DeleteRequest: { Key: { pk: it.pk as string, sk: it.sk as string } },
    }));
    const puts = records.map((r) => ({ PutRequest: { Item: toItem(r) } }));
    // Deletes then puts in SEPARATE batches: a single BatchWrite cannot contain both a
    // Delete and a Put for the same key (a re-replace of the same month reuses keys).
    for (const batch of chunk(deletes, 25)) {
      await this.deps.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: batch } }));
    }
    for (const batch of chunk(puts, 25)) {
      await this.deps.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: batch } }));
    }
  }

  async seed(records: PriceRecord[]): Promise<void> {
    // Group by (service, region) so the same-or-newer-month guard is computed once per key.
    const maxMonthByKey = new Map<string, string>();
    for (const r of records) {
      const key = pk(r.service, r.region);
      if (maxMonthByKey.has(key)) continue;
      const res = await this.deps.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": key },
          ProjectionExpression: "#month",
          ExpressionAttributeNames: { "#month": "month" },
        }),
      );
      const months = (res.Items ?? []).map((it) => it.month as string);
      maxMonthByKey.set(key, months.length > 0 ? months.reduce((a, b) => (b > a ? b : a)) : "");
    }

    for (const r of records) {
      const maxMonth = maxMonthByKey.get(pk(r.service, r.region)) ?? "";
      // Skip if a same-or-newer month is already cached for this (service, region).
      if (maxMonth && maxMonth >= r.month) continue;
      try {
        // attribute_not_exists(pk) → don't clobber an existing exact (service,region,month,unit)
        // row, mirroring SQLite INSERT OR IGNORE.
        await this.deps.doc.send(
          new PutCommand({
            TableName: this.table,
            Item: toItem(r),
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      } catch (err) {
        if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
      }
    }
  }
}
