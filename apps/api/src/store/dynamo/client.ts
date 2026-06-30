/**
 * DynamoDB connection seam (KTD5). Builds the shared DocumentClient + a logical→
 * physical table-name resolver from config, so every DynamoDB store talks to the
 * same client and the table prefix is set in exactly one place.
 *
 * `DYNAMO_ENDPOINT` points the SDK at a local emulator (integration tests); when it
 * is set we supply dummy static credentials so the SDK's credential chain never
 * reaches out to real AWS. In prod it is unset and the standard provider chain +
 * region apply.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { Config } from "../../config.js";

/** Logical table names; physical names are `${prefix}${logical}`. */
export type LogicalTable =
  | "memory"
  | "responseCache"
  | "pricing"
  | "spend"
  | "curated"
  | "feedback"
  | "generations"
  | "designVectors";

export const LOGICAL_TABLES: LogicalTable[] = [
  "memory",
  "responseCache",
  "pricing",
  "spend",
  "curated",
  "feedback",
  "generations",
  "designVectors",
];

export interface DynamoConfig {
  tablePrefix: string;
  region: string;
  /** Local emulator endpoint; unset in prod. */
  endpoint?: string;
}

export interface DynamoDeps {
  doc: DynamoDBDocumentClient;
  raw: DynamoDBClient;
  prefix: string;
  /** Physical name for a logical table. */
  table(logical: LogicalTable): string;
}

export function dynamoConfigFromAppConfig(config: Config): DynamoConfig {
  return {
    tablePrefix: config.DYNAMO_TABLE_PREFIX,
    region: config.DYNAMO_REGION ?? config.DEFAULT_REGION,
    endpoint: config.DYNAMO_ENDPOINT,
  };
}

export function makeDynamoDeps(cfg: DynamoConfig): DynamoDeps {
  const raw = new DynamoDBClient({
    region: cfg.region,
    endpoint: cfg.endpoint,
    // Static dummy creds only when pointed at a local emulator; otherwise let the
    // standard AWS provider chain resolve real credentials.
    credentials: cfg.endpoint
      ? { accessKeyId: "local", secretAccessKey: "local" }
      : undefined,
  });
  // removeUndefinedValues so optional fields (comment, terraformJson, ...) can be
  // omitted rather than written as a NULL attribute — matches the SQLite NULLability.
  const doc = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    doc,
    raw,
    prefix: cfg.tablePrefix,
    table: (logical) => `${cfg.tablePrefix}${logical}`,
  };
}
