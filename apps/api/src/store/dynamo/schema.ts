/**
 * Table definitions for the one-table-per-store layout (plan §2). Keys are chosen to
 * serve each store's access patterns with Query/GetItem (no Scan on a hot path; the
 * two Scans — curated.list and generations.list* — are over tiny, operator-curated
 * corpora, documented at their call sites).
 *
 * Vote child items live in the same table as their parent (curated, generations) under
 * SK `vote#<voter>`; counters are atomic `ADD`s on the parent `meta` item.
 *
 * `createTables`/`deleteTables` are used by the provisioning script and the integration
 * tests (each test run gets fresh tables against the emulator).
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
  type CreateTableCommandInput,
  ResourceNotFoundException,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";

import type { DynamoDeps, LogicalTable } from "./client.js";
import { LOGICAL_TABLES } from "./client.js";

const PAY_PER_REQUEST = "PAY_PER_REQUEST" as const;

/** CreateTable input per logical table, sans the resolved physical TableName. */
function tableInput(logical: LogicalTable, name: string): CreateTableCommandInput {
  switch (logical) {
    case "memory":
      return {
        TableName: name,
        BillingMode: PAY_PER_REQUEST,
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: "S" },
          { AttributeName: "topic", AttributeType: "S" },
          { AttributeName: "updatedAt", AttributeType: "N" },
        ],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        GlobalSecondaryIndexes: [
          {
            IndexName: "topic-index",
            KeySchema: [
              { AttributeName: "topic", KeyType: "HASH" },
              { AttributeName: "updatedAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      };
    case "responseCache":
      return {
        TableName: name,
        BillingMode: PAY_PER_REQUEST,
        AttributeDefinitions: [{ AttributeName: "promptHash", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "promptHash", KeyType: "HASH" }],
      };
    case "pricing":
      return {
        TableName: name,
        BillingMode: PAY_PER_REQUEST,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "regionMonth", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "regionMonth-index",
            KeySchema: [{ AttributeName: "regionMonth", KeyType: "HASH" }],
            // Keys only: replaceMonth just needs (pk, sk) to batch-delete the month.
            Projection: { ProjectionType: "KEYS_ONLY" },
          },
        ],
      };
    case "spend":
      return {
        TableName: name,
        BillingMode: PAY_PER_REQUEST,
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      };
    case "curated":
      return {
        TableName: name,
        BillingMode: PAY_PER_REQUEST,
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "id", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      };
    case "feedback":
      return {
        TableName: name,
        BillingMode: PAY_PER_REQUEST,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "rating", AttributeType: "N" },
          { AttributeName: "updatedAt", AttributeType: "N" },
        ],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        GlobalSecondaryIndexes: [
          {
            IndexName: "rating-index",
            KeySchema: [
              { AttributeName: "rating", KeyType: "HASH" },
              { AttributeName: "updatedAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      };
    case "generations":
      return {
        TableName: name,
        BillingMode: PAY_PER_REQUEST,
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "promptHash", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "id", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            // Sparse: only the `meta` item carries promptHash, so vote items are
            // excluded. getByPromptHash + upsert-by-promptHash query this.
            IndexName: "promptHash-index",
            KeySchema: [{ AttributeName: "promptHash", KeyType: "HASH" }],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      };
    case "designVectors":
      return {
        TableName: name,
        BillingMode: PAY_PER_REQUEST,
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: "S" },
          { AttributeName: "model", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        GlobalSecondaryIndexes: [
          {
            IndexName: "model-index",
            KeySchema: [{ AttributeName: "model", KeyType: "HASH" }],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      };
  }
}

/** Create every table (idempotent: an already-existing table is left as-is), wait
 *  for ACTIVE, then enable native TTL on the response cache. */
export async function createTables(deps: DynamoDeps): Promise<void> {
  for (const logical of LOGICAL_TABLES) {
    const name = deps.table(logical);
    try {
      await deps.raw.send(new CreateTableCommand(tableInput(logical, name)));
    } catch (err) {
      if (!(err instanceof ResourceInUseException)) throw err;
    }
    await waitUntilTableExists({ client: deps.raw, maxWaitTime: 60 }, { TableName: name });
  }
  // Native TTL: DynamoDB reaps items whose `expiresAt` (epoch seconds) has passed.
  // Best-effort — already-enabled is fine; the cache's in-read TTL check is the
  // correctness guarantee, this just stops the table growing unbounded.
  try {
    await deps.raw.send(
      new UpdateTimeToLiveCommand({
        TableName: deps.table("responseCache"),
        TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" },
      }),
    );
  } catch {
    // TTL already enabled or emulator without TTL support — ignore.
  }
}

/** Drop every table (idempotent). Used to reset between integration-test runs. */
export async function deleteTables(deps: DynamoDeps): Promise<void> {
  for (const logical of LOGICAL_TABLES) {
    const name = deps.table(logical);
    try {
      await deps.raw.send(new DeleteTableCommand({ TableName: name }));
      await waitUntilTableNotExists({ client: deps.raw, maxWaitTime: 60 }, { TableName: name });
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
  }
}
