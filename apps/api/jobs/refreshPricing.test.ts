import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, createStores, type Stores } from "../src/store/sqlite.js";
import type { PriceRecord } from "../src/store/types.js";
import {
  refreshPricing,
  type RefreshDeps,
  type RegionPriceFile,
} from "./refreshPricing.js";

const REGION = "us-east-1";

// ── Fixtures: a tiny stand-in for the public Bulk offer files ────────────────
// Real per-region files are hundreds of MB; these prove normalization without
// any network or large allocation (the huge-file seam is `loadRegionFile`).

const INDEX = {
  offers: {
    AWSLambda: {
      offerCode: "AWSLambda",
      currentRegionIndexUrl: "/offers/v1.0/aws/AWSLambda/current/region_index.json",
    },
    AWSQueueService: {
      offerCode: "AWSQueueService",
      currentRegionIndexUrl: "/offers/v1.0/aws/AWSQueueService/current/region_index.json",
    },
    AmazonEC2: {
      offerCode: "AmazonEC2",
      currentRegionIndexUrl: "/offers/v1.0/aws/AmazonEC2/current/region_index.json",
    },
  },
};

function regionIndexFor(offerCode: string) {
  return {
    regions: {
      [REGION]: {
        regionCode: REGION,
        currentVersionUrl: `/offers/v1.0/aws/${offerCode}/20260601000000/${REGION}/index.json`,
      },
    },
  };
}

const LAMBDA_FILE: RegionPriceFile = {
  products: {
    REQ: { sku: "REQ", productFamily: "Serverless", attributes: { group: "AWS-Lambda-Requests" } },
    DUR: { sku: "DUR", productFamily: "Serverless", attributes: { group: "AWS-Lambda-Duration" } },
  },
  terms: {
    OnDemand: {
      REQ: { "REQ.T": { priceDimensions: { "REQ.T.D": { unit: "Requests", pricePerUnit: { USD: "0.0000002" } } } } },
      DUR: { "DUR.T": { priceDimensions: { "DUR.T.D": { unit: "GB-Seconds", pricePerUnit: { USD: "0.0000166667" } } } } },
    },
  },
};

const SQS_FILE: RegionPriceFile = {
  products: {
    SQS: { sku: "SQS", productFamily: "API Request", attributes: { group: "SQS-APIRequest" } },
  },
  terms: {
    OnDemand: {
      // Two request tiers; the cheaper first-tier list price must win.
      SQS: {
        "SQS.T": {
          priceDimensions: {
            "SQS.T.D1": { unit: "Requests", pricePerUnit: { USD: "0.0000004" } },
            "SQS.T.D2": { unit: "Requests", pricePerUnit: { USD: "0.0000006" } },
          },
        },
      },
    },
  },
};

const EC2_DATA_TRANSFER_FILE: RegionPriceFile = {
  products: {
    DTO: {
      sku: "DTO",
      productFamily: "Data Transfer",
      attributes: { transferType: "AWS Outbound", usagetype: "DataTransfer-Out-Bytes" },
    },
  },
  terms: {
    OnDemand: {
      DTO: { "DTO.T": { priceDimensions: { "DTO.T.D": { unit: "GB", pricePerUnit: { USD: "0.09" } } } } },
    },
  },
};

function regionFileFor(url: string): RegionPriceFile {
  if (url.includes("AWSLambda")) return LAMBDA_FILE;
  if (url.includes("AWSQueueService")) return SQS_FILE;
  if (url.includes("AmazonEC2")) return EC2_DATA_TRANSFER_FILE;
  throw new Error(`unexpected region file url: ${url}`);
}

function makeDeps(over: Partial<RefreshDeps> = {}): Partial<RefreshDeps> {
  return {
    fetchJson: async (url: string) => {
      if (url.endsWith("/aws/index.json")) return INDEX;
      if (url.includes("AWSLambda")) return regionIndexFor("AWSLambda");
      if (url.includes("AWSQueueService")) return regionIndexFor("AWSQueueService");
      if (url.includes("AmazonEC2")) return regionIndexFor("AmazonEC2");
      throw new Error(`unexpected index url: ${url}`);
    },
    loadRegionFile: async (url: string) => regionFileFor(url),
    now: () => new Date("2026-06-15T00:00:00Z"),
    ...over,
  };
}

function unitMap(records: PriceRecord[]): Map<string, PriceRecord> {
  return new Map(records.map((r) => [r.unit, r]));
}

describe("refreshPricing", () => {
  let stores: Stores;

  beforeEach(() => {
    stores = createStores(openTempDb());
  });

  it("normalizes offer files into native units and writes the snapshot month", async () => {
    const result = await refreshPricing({ pricing: stores.pricing, region: REGION, deps: makeDeps() });

    expect(result.ok).toBe(true);
    expect(result.month).toBe("2026-06");
    expect(result.fellBackToSeed).toBe(false);
    expect(result.servicesRefreshed).toBe(3);

    // Lambda is a DUAL-unit service: per-1k requests AND $/GB-second (KTD6).
    const lambda = unitMap(await stores.pricing.get("Lambda", REGION));
    expect(lambda.get("per-1k-requests")?.usd).toBeCloseTo(0.0002, 10); // 0.0000002 × 1000
    expect(lambda.get("gb-second")?.usd).toBeCloseTo(0.0000166667, 12);
    expect(lambda.get("per-1k-requests")?.month).toBe("2026-06");

    // SQS request price normalized per-1k, cheapest tier wins.
    const sqs = unitMap(await stores.pricing.get("SQS", REGION));
    expect(sqs.get("per-1k-requests")?.usd).toBeCloseTo(0.0004, 10); // 0.0000004 × 1000

    // Data transfer is surfaced as a first-class native unit.
    const dt = unitMap(await stores.pricing.get("Data Transfer", REGION));
    expect(dt.get("gb-internet-egress")?.usd).toBeCloseTo(0.09, 10);
  });

  it("replaces a stale month with the new month atomically (no duplicates)", async () => {
    // Pre-seed an older snapshot for Lambda.
    await stores.pricing.replaceMonth(REGION, "2026-05", [
      { service: "Lambda", region: REGION, unit: "per-1k-requests", usd: 0.99, month: "2026-05", note: "stale" },
    ]);

    await refreshPricing({ pricing: stores.pricing, region: REGION, deps: makeDeps() });

    // get() prefers the freshest month — the refreshed 2026-06 snapshot.
    const lambda = unitMap(await stores.pricing.get("Lambda", REGION));
    expect(lambda.get("per-1k-requests")?.month).toBe("2026-06");
    expect(lambda.get("per-1k-requests")?.usd).toBeCloseTo(0.0002, 10);

    // Re-running the same month replaces, never duplicates.
    await refreshPricing({ pricing: stores.pricing, region: REGION, deps: makeDeps() });
    expect((await stores.pricing.get("Lambda", REGION)).filter((r) => r.unit === "per-1k-requests")).toHaveLength(1);
  });

  it("leaves the prior cache intact on failure (no partial wipe, R10)", async () => {
    // A previously-cached current month that the refresh must not clobber.
    const prior: PriceRecord = {
      service: "Lambda",
      region: REGION,
      unit: "per-1k-requests",
      usd: 0.0002,
      month: "2026-06",
      note: "prior good snapshot",
    };
    await stores.pricing.replaceMonth(REGION, "2026-06", [prior]);

    // Fail mid-walk (region file load throws). now() => same 2026-06 month.
    const result = await refreshPricing({
      pricing: stores.pricing,
      region: REGION,
      deps: makeDeps({
        loadRegionFile: async () => {
          throw new Error("network exploded");
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.fellBackToSeed).toBe(true);
    expect(result.error).toMatch(/network exploded/);

    // Cache untouched: the prior 2026-06 row survives unchanged.
    const lambda = await stores.pricing.get("Lambda", REGION);
    expect(lambda).toHaveLength(1);
    expect(lambda[0]?.note).toBe("prior good snapshot");
  });

  it("treats an empty extraction as failure and leaves the cache intact", async () => {
    await stores.pricing.replaceMonth(REGION, "2026-06", [
      { service: "Lambda", region: REGION, unit: "per-1k-requests", usd: 0.0002, month: "2026-06", note: "prior" },
    ]);

    // Index returns no known offers → nothing extracted.
    const result = await refreshPricing({
      pricing: stores.pricing,
      region: REGION,
      deps: makeDeps({ fetchJson: async () => ({ offers: {} }) }),
    });

    expect(result.ok).toBe(false);
    expect(result.fellBackToSeed).toBe(true);
    expect((await stores.pricing.get("Lambda", REGION))[0]?.note).toBe("prior");
  });
});
