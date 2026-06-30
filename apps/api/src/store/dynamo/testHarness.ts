/**
 * Integration-test harness for the DynamoDB stores. Points the SDK at a local emulator
 * (DynamoDB Local in Docker — see vitest.dynamo.config.ts globalSetup) and provides
 * table create + fast per-test data clearing so each test starts from a clean slate
 * without the cost of dropping/recreating tables every time.
 *
 * Endpoint comes from DYNAMO_TEST_ENDPOINT (default http://127.0.0.1:8000). Region/creds
 * are dummies — DynamoDB Local ignores them.
 */
import { ScanCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

import { makeDynamoDeps, type DynamoDeps, type LogicalTable } from "./client.js";
import { createTables } from "./schema.js";

export const TEST_ENDPOINT = process.env.DYNAMO_TEST_ENDPOINT ?? "http://127.0.0.1:8000";

/** Key attribute names per table, used to build DeleteRequests when clearing data. */
const KEY_ATTRS: Record<LogicalTable, string[]> = {
  memory: ["id"],
  responseCache: ["promptHash"],
  pricing: ["pk", "sk"],
  spend: ["pk"],
  curated: ["id", "sk"],
  feedback: ["pk"],
  generations: ["id", "sk"],
  designVectors: ["id"],
};

export function makeTestDeps(prefix: string): DynamoDeps {
  return makeDynamoDeps({ tablePrefix: prefix, region: "local", endpoint: TEST_ENDPOINT });
}

/** Create all tables for this prefix (idempotent). Call once in beforeAll. */
export async function ensureTables(deps: DynamoDeps): Promise<void> {
  await createTables(deps);
}

/** Delete every item from the given tables (fast per-test reset; keeps the tables). */
export async function clearTables(deps: DynamoDeps, tables: LogicalTable[]): Promise<void> {
  for (const logical of tables) {
    const name = deps.table(logical);
    const keyAttrs = KEY_ATTRS[logical];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const scan = await deps.doc.send(
        new ScanCommand({
          TableName: name,
          ProjectionExpression: keyAttrs.map((_, i) => `#k${i}`).join(", "),
          ExpressionAttributeNames: Object.fromEntries(keyAttrs.map((a, i) => [`#k${i}`, a])),
          ExclusiveStartKey: lastKey,
        }),
      );
      const items = scan.Items ?? [];
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25).map((it) => ({
          DeleteRequest: { Key: Object.fromEntries(keyAttrs.map((a) => [a, it[a]])) },
        }));
        if (batch.length > 0) {
          await deps.doc.send(new BatchWriteCommand({ RequestItems: { [name]: batch } }));
        }
      }
      lastKey = scan.LastEvaluatedKey;
    } while (lastKey);
  }
}
