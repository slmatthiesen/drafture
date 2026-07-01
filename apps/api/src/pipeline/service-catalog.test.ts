import { describe, expect, it } from "vitest";

import catalog from "@drafture/kb/service-catalog.json" with { type: "json" };
import type { ServiceCatalog } from "@drafture/kb";

// Every ServiceKey the TF emitter registry knows about, MINUS the "unsupported"
// sentinel (a catalog entry for it would be meaningless — it's the fallback for
// an svc the normalizer couldn't classify at all). Kept as a literal list (not
// imported) so this test independently double-checks the vocabulary the emitter
// and the catalog are meant to share (serviceKey.ts's own union is the source of
// truth for the emitter side).
const EXPECTED_SERVICE_KEYS = [
  "cloudfront",
  "s3",
  "ec2",
  "postgres-selfmanaged",
  "lambda",
  "eventbridge-scheduler",
  "eventbridge-bus",
  "secrets-manager",
  "ssm",
  "cloudwatch-logs",
  "cloudwatch-alarms",
  "cloudwatch-dashboard",
  "cloudwatch-anomaly",
  "sns",
  "sqs",
  "xray",
  "cloudtrail",
  "alb",
  "fargate",
  "rds",
  "elasticache",
  "nat",
  "dynamo",
  "apigw",
  "cognito",
  "ses",
  "step-functions",
  "kinesis",
  "opensearch",
] as const;

const CATALOG = catalog as ServiceCatalog;

describe("service catalog coverage", () => {
  it("has an entry for every emitter ServiceKey", () => {
    const missing = EXPECTED_SERVICE_KEYS.filter((key) => !CATALOG[key]);
    expect(missing).toEqual([]);
  });

  it("every entry has a canonical awsService name and a floorTags array", () => {
    for (const [key, entry] of Object.entries(CATALOG)) {
      expect(entry.awsService, `${key}.awsService`).toBeTruthy();
      expect(Array.isArray(entry.floorTags), `${key}.floorTags`).toBe(true);
    }
  });

  it("carries no keys outside the expected emitter vocabulary (one vocabulary everywhere)", () => {
    const extra = Object.keys(CATALOG).filter((key) => !(EXPECTED_SERVICE_KEYS as readonly string[]).includes(key));
    expect(extra).toEqual([]);
  });
});
