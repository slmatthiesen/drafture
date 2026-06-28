import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, type Db, type Clock } from "./sqlite.js";
import { SqliteGenerationsStore } from "./generations.js";

function makeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Net-vote threshold passed by the route from ctx.config.GENERATION_HIDE_NET_VOTES. */
const HIDE_AT = -3;

const input = (promptHash: string, desc = "build a chat app") => ({
  promptHash,
  description: desc,
  answers: [],
  model: "claude-sonnet-4-6",
  region: "us-east-1",
  recommendedTier: "balanced",
  tags: ["messaging", "realtime"],
  body: JSON.stringify({ recommendedTier: "balanced", tiers: [] }),
  clientIp: "1.1.1.1",
});

describe("SqliteGenerationsStore", () => {
  let db: Db;
  let store: SqliteGenerationsStore;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    db = openTempDb();
    clock = makeClock(1_000);
    store = new SqliteGenerationsStore(db, clock);
  });

  it("upsert creates a pending row and returns its id", () => {
    const { id, status } = store.upsert(input("hash1"));
    expect(id).toBeTruthy();
    expect(status).toBe("pending");
    const got = store.getById(id);
    expect(got?.description).toBe("build a chat app");
    expect(got?.genCount).toBe(1);
    expect(got?.tags).toEqual(["messaging", "realtime"]);
  });

  it("upsert on same promptHash bumps genCount, refreshes body, preserves id+status+votes", () => {
    const first = store.upsert(input("hash1", "v1"));
    store.vote(first.id, "ipA", 1, HIDE_AT);
    store.setStatus(first.id, "approved");
    clock.advance(50);

    const second = store.upsert(input("hash1", "v2 — refreshed"));
    expect(second.id).toBe(first.id); // stable deep link
    expect(second.status).toBe("approved"); // preserved across refresh

    const got = store.getById(first.id);
    expect(got?.description).toBe("v2 — refreshed");
    expect(got?.genCount).toBe(2);
    expect(got?.upvotes).toBe(1); // preserved
  });

  it("a different promptHash is a separate row — prior version kept (model-pinned)", () => {
    const a = store.upsert(input("hash-sonnet"));
    const b = store.upsert(input("hash-glm"));
    expect(a.id).not.toBe(b.id);
    expect(store.getById(a.id)).toBeDefined();
    expect(store.getById(b.id)).toBeDefined();
  });

  it("getByPromptHash finds the row", () => {
    const { id } = store.upsert(input("hash1"));
    expect(store.getByPromptHash("hash1")?.id).toBe(id);
    expect(store.getByPromptHash("nope")).toBeUndefined();
  });

  it("listPending returns only pending rows", () => {
    const a = store.upsert(input("h1"));
    store.upsert(input("h2"));
    store.setStatus(a.id, "approved");
    const pending = store.listPending(10);
    expect(pending.every((p) => p.status === "pending")).toBe(true);
    expect(pending.length).toBe(1);
  });

  it("listApproved returns only approved rows, best community score first", () => {
    const a = store.upsert(input("h1"));
    const b = store.upsert(input("h2"));
    store.setStatus(a.id, "approved");
    store.setStatus(b.id, "approved");
    store.vote(b.id, "ip1", 1, HIDE_AT); // b outscores a
    const approved = store.listApproved(10);
    expect(approved.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("setStatus returns false for an unknown id", () => {
    expect(store.setStatus("nope", "approved")).toBe(false);
  });

  it("vote increments counters and is one-per-voter", () => {
    const { id } = store.upsert(input("h1"));
    expect(store.vote(id, "ip1", 1, HIDE_AT)).toEqual({ upvotes: 1, downvotes: 0, status: "pending" });
    expect(store.vote(id, "ip2", -1, HIDE_AT)).toEqual({ upvotes: 1, downvotes: 1, status: "pending" });
    // same voter changes their vote rather than stacking
    expect(store.vote(id, "ip1", -1, HIDE_AT)).toEqual({ upvotes: 0, downvotes: 2, status: "pending" });
  });

  it("vote on an unknown id returns undefined", () => {
    expect(store.vote("nope", "ip1", 1, HIDE_AT)).toBeUndefined();
  });

  it("auto-hides an approved design when net votes reach the threshold", () => {
    const { id } = store.upsert(input("h1"));
    store.setStatus(id, "approved");
    store.vote(id, "ip1", -1, HIDE_AT); // net -1
    store.vote(id, "ip2", -1, HIDE_AT); // net -2
    const atThreshold = store.vote(id, "ip3", -1, HIDE_AT); // net -3 ≤ -3 → hidden
    expect(atThreshold?.status).toBe("hidden");
    expect(store.getById(id)?.status).toBe("hidden");
  });

  it("does NOT hide a pending design (only approved rows auto-hide)", () => {
    const { id } = store.upsert(input("h1"));
    const r = store.vote(id, "ip1", -1, HIDE_AT);
    expect(r?.status).toBe("pending");
  });

  it("setTerraform/getTerraform round-trip per tier and coexist", () => {
    const { id } = store.upsert(input("h1"));
    expect(store.getTerraform(id, "balanced")).toBeUndefined();
    expect(store.setTerraform(id, "balanced", "resource x {}")).toBe(true);
    expect(store.getTerraform(id, "balanced")?.code).toBe("resource x {}");
    expect(store.getTerraform(id, "resilient")).toBeUndefined();
    store.setTerraform(id, "resilient", "resource y {}");
    expect(store.getTerraform(id, "resilient")?.code).toBe("resource y {}");
    expect(store.getTerraform(id, "balanced")?.code).toBe("resource x {}"); // untouched
  });

  it("setTerraform on an unknown id returns false", () => {
    expect(store.setTerraform("nope", "balanced", "x")).toBe(false);
  });
});
