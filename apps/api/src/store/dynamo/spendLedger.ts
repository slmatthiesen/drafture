/**
 * DynamoDB-backed SpendLedger (KTD7/KTD8) — the load-bearing no-overshoot guard.
 *
 * SQLite gets atomicity free by serializing writers; DynamoDB does not, so the daily
 * ceiling is enforced with OPTIMISTIC CONCURRENCY on a single day-counter item:
 * read `spentToday` + `version`, then conditionally `spentToday += provisional` with
 * `ConditionExpression version = :v AND spentToday + :p <= :ceil`. A concurrent writer
 * that slipped in bumps `version`, so the condition fails, we re-read and retry — two
 * requests can never each pass the ceiling check (the bug a naive port introduces).
 *
 * The counter update + the reservation-item write run in ONE TransactWriteItems, so a
 * reservation always has a matching counter debit (reconcile/release stay exact).
 *
 * Layout (one `spend` table, PK only):
 *   counter#<day>  → { spentToday, version }   the per-day running total
 *   res#<id>       → { day, amountUsd, status } one row per outstanding reservation
 *   ip#<ip>#<day>  → { count }                  per-IP daily generation counter
 */
import { randomUUID } from "node:crypto";

import { GetCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import type { SpendLedger, SpendReservation } from "../types.js";
import type { Clock } from "../clock.js";
import { systemClock, utcDayKey } from "../clock.js";
import type { DynamoDeps } from "./client.js";

/** Bounded retries for the optimistic reserve loop before giving up (fail-closed). */
const MAX_RESERVE_ATTEMPTS = 8;

interface CounterItem {
  spentToday?: number;
  version?: number;
}

interface ReservationItem {
  day: string;
  amountUsd: number;
  status: "provisional" | "reconciled";
}

function isConditionFailure(err: unknown): boolean {
  const name = (err as Error)?.name;
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
}

export class DynamoSpendLedger implements SpendLedger {
  constructor(
    private readonly deps: DynamoDeps,
    private readonly clock: Clock = systemClock,
  ) {}

  private get table(): string {
    return this.deps.table("spend");
  }

  private today(): string {
    return utcDayKey(this.clock.now());
  }

  private counterKey(day: string): string {
    return `counter#${day}`;
  }

  private async readCounter(day: string): Promise<{ spentToday: number; version: number } | undefined> {
    const res = await this.deps.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: this.counterKey(day) }, ConsistentRead: true }),
    );
    const item = res.Item as CounterItem | undefined;
    if (!item) return undefined;
    return { spentToday: item.spentToday ?? 0, version: item.version ?? 0 };
  }

  /** Idempotently create the day counter at zero so every reserve operates on an
   *  existing item (the conditional update can then always check the ceiling). */
  private async ensureCounter(day: string): Promise<void> {
    await this.deps.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: this.counterKey(day) },
        UpdateExpression: "SET spentToday = if_not_exists(spentToday, :z), version = if_not_exists(version, :z)",
        ExpressionAttributeValues: { ":z": 0 },
      }),
    );
  }

  async reserve(provisionalUsd: number, ceilingUsd: number): Promise<SpendReservation> {
    const day = this.today();
    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
      let cur = await this.readCounter(day);
      if (!cur) {
        await this.ensureCounter(day);
        cur = { spentToday: 0, version: 0 };
      }
      // Fast reject when clearly over (covers the empty-day p>ceiling case too).
      if (cur.spentToday + provisionalUsd > ceilingUsd) {
        return { ok: false, reservationId: "", spentTodayUsd: cur.spentToday, ceilingUsd };
      }
      const reservationId = randomUUID();
      try {
        await this.deps.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.table,
                  Key: { pk: this.counterKey(day) },
                  UpdateExpression: "SET spentToday = spentToday + :p, version = version + :one",
                  // DynamoDB forbids arithmetic in a ConditionExpression, so the ceiling
                  // check is rewritten `spentToday + p <= ceil` ⟺ `spentToday <= ceil - p`
                  // with the RHS precomputed. The SET (arithmetic allowed there) still adds :p.
                  ConditionExpression: "version = :v AND spentToday <= :maxAllowed",
                  ExpressionAttributeValues: {
                    ":p": provisionalUsd,
                    ":one": 1,
                    ":v": cur.version,
                    ":maxAllowed": ceilingUsd - provisionalUsd,
                  },
                },
              },
              {
                Put: {
                  TableName: this.table,
                  Item: {
                    pk: `res#${reservationId}`,
                    day,
                    amountUsd: provisionalUsd,
                    status: "provisional",
                  },
                },
              },
            ],
          }),
        );
        return {
          ok: true,
          reservationId,
          spentTodayUsd: cur.spentToday + provisionalUsd,
          ceilingUsd,
        };
      } catch (err) {
        if (isConditionFailure(err)) continue; // a concurrent writer moved version/total — re-read & retry
        throw err;
      }
    }
    // Exhausted retries under contention — fail closed (never overshoot).
    const cur = await this.readCounter(day);
    return { ok: false, reservationId: "", spentTodayUsd: cur?.spentToday ?? 0, ceilingUsd };
  }

  async reconcile(reservationId: string, actualUsd: number): Promise<void> {
    const res = await this.deps.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `res#${reservationId}` }, ConsistentRead: true }),
    );
    const item = res.Item as ReservationItem | undefined;
    if (!item || item.status === "reconciled") return; // unknown or already reconciled — idempotent no-op
    const delta = actualUsd - item.amountUsd;
    try {
      await this.deps.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { pk: this.counterKey(item.day) },
                UpdateExpression: "SET spentToday = spentToday + :delta",
                ExpressionAttributeValues: { ":delta": delta },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { pk: `res#${reservationId}` },
                UpdateExpression: "SET amountUsd = :actual, #status = :reconciled",
                ConditionExpression: "#status = :provisional",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":actual": actualUsd,
                  ":reconciled": "reconciled",
                  ":provisional": "provisional",
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (isConditionFailure(err)) return; // raced with another reconcile — leave the first one's effect
      throw err;
    }
  }

  async release(reservationId: string): Promise<void> {
    const res = await this.deps.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `res#${reservationId}` }, ConsistentRead: true }),
    );
    const item = res.Item as ReservationItem | undefined;
    if (!item) return; // already gone — idempotent
    try {
      await this.deps.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { pk: this.counterKey(item.day) },
                UpdateExpression: "SET spentToday = spentToday - :amount",
                ExpressionAttributeValues: { ":amount": item.amountUsd },
              },
            },
            {
              Delete: {
                TableName: this.table,
                Key: { pk: `res#${reservationId}` },
                ConditionExpression: "attribute_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (isConditionFailure(err)) return; // already released concurrently — counter left intact
      throw err;
    }
  }

  async spentTodayUsd(): Promise<number> {
    const cur = await this.readCounter(this.today());
    return cur?.spentToday ?? 0;
  }

  async incrementIpCount(ip: string): Promise<number> {
    const day = this.today();
    const res = await this.deps.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `ip#${ip}#${day}` },
        UpdateExpression: "ADD #count :one",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return (res.Attributes?.count as number | undefined) ?? 1;
  }

  async ipCountToday(ip: string): Promise<number> {
    const res = await this.deps.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `ip#${ip}#${this.today()}` } }),
    );
    return (res.Item?.count as number | undefined) ?? 0;
  }
}
