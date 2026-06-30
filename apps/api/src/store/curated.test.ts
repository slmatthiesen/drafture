import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, type Db, type Clock } from "./sqlite.js";
import { SqliteCuratedStore } from "./curated.js";

function makeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const run = (id: string, title: string) => ({
  id,
  title,
  prompt: `prompt for ${title}`,
  body: JSON.stringify({ recommendedTier: "balanced", tiers: [] }),
});

describe("SqliteCuratedStore", () => {
  let db: Db;
  let store: SqliteCuratedStore;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    db = openTempDb();
    clock = makeClock(1_000);
    store = new SqliteCuratedStore(db, clock);
  });

  it("upsert then get returns the stored run with its body", () => {
    store.upsert(run("a", "Alpha"));
    const got = store.get("a");
    expect(got?.title).toBe("Alpha");
    expect(got?.upvotes).toBe(0);
    expect(JSON.parse(got!.body)).toEqual({ recommendedTier: "balanced", tiers: [] });
  });

  it("get returns undefined for an unknown id", () => {
    expect(store.get("missing")).toBeUndefined();
  });

  it("list omits the body and is ordered by score then recency", () => {
    store.upsert(run("a", "Alpha"));
    clock.advance(10);
    store.upsert(run("b", "Beta"));
    store.vote("b", "ip1", 1); // Beta now outscores Alpha

    const list = store.list();
    expect(list.map((r) => r.id)).toEqual(["b", "a"]);
    expect((list[0] as { body?: string }).body).toBeUndefined();
  });

  it("list derives a one-line tech blurb from the recommended tier's services", () => {
    const body = JSON.stringify({
      recommendedTier: "balanced",
      tiers: [
        { name: "budget", nodes: [{ awsService: "Lambda" }] },
        {
          name: "balanced",
          nodes: [
            { awsService: "API Gateway" },
            { awsService: "Lambda" },
            { awsService: "DynamoDB" },
            { awsService: "Lambda" }, // dupe — must be collapsed
            { awsService: "S3" },
            { awsService: "CloudFront" }, // beyond the 4-service cap — dropped
          ],
        },
      ],
    });
    store.upsert({ id: "x", title: "X", prompt: "p", body });
    expect(store.list()[0]!.tech).toBe("API Gateway · Lambda · DynamoDB · S3");
  });

  it("vote increments the matching counter", () => {
    store.upsert(run("a", "Alpha"));
    expect(store.vote("a", "ip1", 1)).toEqual({ upvotes: 1, downvotes: 0 });
    expect(store.vote("a", "ip2", -1)).toEqual({ upvotes: 1, downvotes: 1 });
  });

  it("a voter's second vote replaces their first (one vote per voter)", () => {
    store.upsert(run("a", "Alpha"));
    store.vote("a", "ip1", 1);
    const after = store.vote("a", "ip1", -1);
    expect(after).toEqual({ upvotes: 0, downvotes: 1 });
  });

  it("vote on an unknown run returns undefined and records nothing", () => {
    expect(store.vote("nope", "ip1", 1)).toBeUndefined();
  });

  it("re-upsert replaces content but preserves accumulated votes", () => {
    store.upsert(run("a", "Alpha"));
    store.vote("a", "ip1", 1);
    store.upsert({ ...run("a", "Alpha v2"), prompt: "new prompt" });

    const got = store.get("a");
    expect(got?.title).toBe("Alpha v2");
    expect(got?.prompt).toBe("new prompt");
    expect(got?.upvotes).toBe(1);
  });

  it("setHidden removes a run from list AND get (every served surface), and restores it", () => {
    store.upsert(run("a", "Alpha"));
    store.upsert(run("b", "Beta"));

    expect(store.setHidden("a", true)).toBe(true);
    // Gallery (list) and the deep-link/RAG read path (get) both drop the hidden run.
    expect(store.list().map((r) => r.id)).toEqual(["b"]);
    expect(store.get("a")).toBeUndefined();

    // Restorable — the suppression is a reversible flag, not a delete.
    expect(store.setHidden("a", false)).toBe(true);
    expect(store.get("a")?.title).toBe("Alpha");
  });

  it("re-upsert (re-seed) preserves a run's hidden flag", () => {
    store.upsert(run("a", "Alpha"));
    store.setHidden("a", true);
    store.upsert({ ...run("a", "Alpha v2"), prompt: "re-seeded" });
    expect(store.get("a")).toBeUndefined(); // still hidden after a seed re-run
  });

  it("setHidden returns false for an unknown id", () => {
    expect(store.setHidden("nope", true)).toBe(false);
  });
});
