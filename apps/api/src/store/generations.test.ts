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

  it("upsert creates a pending row and returns its id", async () => {
    const { id, status } = await store.upsert(input("hash1"));
    expect(id).toBeTruthy();
    expect(status).toBe("pending");
    const got = await store.getById(id);
    expect(got?.description).toBe("build a chat app");
    expect(got?.genCount).toBe(1);
    expect(got?.tags).toEqual(["messaging", "realtime"]);
  });

  it("upsert on same promptHash bumps genCount, refreshes body, preserves id+status+votes", async () => {
    const first = await store.upsert(input("hash1", "v1"));
    await store.vote(first.id, "ipA", 1, HIDE_AT);
    await store.setStatus(first.id, "approved");
    clock.advance(50);

    const second = await store.upsert(input("hash1", "v2 — refreshed"));
    expect(second.id).toBe(first.id); // stable deep link
    expect(second.status).toBe("approved"); // preserved across refresh

    const got = await store.getById(first.id);
    expect(got?.description).toBe("v2 — refreshed");
    expect(got?.genCount).toBe(2);
    expect(got?.upvotes).toBe(1); // preserved
  });

  it("a different promptHash is a separate row — prior version kept (model-pinned)", async () => {
    const a = await store.upsert(input("hash-sonnet"));
    const b = await store.upsert(input("hash-glm"));
    expect(a.id).not.toBe(b.id);
    expect(await store.getById(a.id)).toBeDefined();
    expect(await store.getById(b.id)).toBeDefined();
  });

  it("getByPromptHash finds the row", async () => {
    const { id } = await store.upsert(input("hash1"));
    expect((await store.getByPromptHash("hash1"))?.id).toBe(id);
    expect(await store.getByPromptHash("nope")).toBeUndefined();
  });

  it("listPending returns only pending rows", async () => {
    const a = await store.upsert(input("h1"));
    await store.upsert(input("h2"));
    await store.setStatus(a.id, "approved");
    const pending = await store.listPending(10);
    expect(pending.every((p) => p.status === "pending")).toBe(true);
    expect(pending.length).toBe(1);
  });

  it("listApproved returns only approved rows, best community score first", async () => {
    const a = await store.upsert(input("h1"));
    const b = await store.upsert(input("h2"));
    await store.setStatus(a.id, "approved");
    await store.setStatus(b.id, "approved");
    await store.vote(b.id, "ip1", 1, HIDE_AT); // b outscores a
    const approved = await store.listApproved(10);
    expect(approved.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("setStatus returns false for an unknown id", async () => {
    expect(await store.setStatus("nope", "approved")).toBe(false);
  });

  it("vote increments counters and is one-per-voter", async () => {
    const { id } = await store.upsert(input("h1"));
    expect(await store.vote(id, "ip1", 1, HIDE_AT)).toEqual({ upvotes: 1, downvotes: 0, status: "pending" });
    expect(await store.vote(id, "ip2", -1, HIDE_AT)).toEqual({ upvotes: 1, downvotes: 1, status: "pending" });
    // same voter changes their vote rather than stacking
    expect(await store.vote(id, "ip1", -1, HIDE_AT)).toEqual({ upvotes: 0, downvotes: 2, status: "pending" });
  });

  it("vote on an unknown id returns undefined", async () => {
    expect(await store.vote("nope", "ip1", 1, HIDE_AT)).toBeUndefined();
  });

  it("auto-hides an approved design when net votes reach the threshold", async () => {
    const { id } = await store.upsert(input("h1"));
    await store.setStatus(id, "approved");
    await store.vote(id, "ip1", -1, HIDE_AT); // net -1
    await store.vote(id, "ip2", -1, HIDE_AT); // net -2
    const atThreshold = await store.vote(id, "ip3", -1, HIDE_AT); // net -3 ≤ -3 → hidden
    expect(atThreshold?.status).toBe("hidden");
    expect((await store.getById(id))?.status).toBe("hidden");
  });

  it("does NOT hide a pending design (only approved rows auto-hide)", async () => {
    const { id } = await store.upsert(input("h1"));
    const r = await store.vote(id, "ip1", -1, HIDE_AT);
    expect(r?.status).toBe("pending");
  });

  it("setTerraform/getTerraform round-trip per tier and coexist", async () => {
    const { id } = await store.upsert(input("h1"));
    expect(await store.getTerraform(id, "balanced")).toBeUndefined();
    expect(await store.setTerraform(id, "balanced", "resource x {}")).toBe(true);
    expect((await store.getTerraform(id, "balanced"))?.code).toBe("resource x {}");
    expect(await store.getTerraform(id, "resilient")).toBeUndefined();
    await store.setTerraform(id, "resilient", "resource y {}");
    expect((await store.getTerraform(id, "resilient"))?.code).toBe("resource y {}");
    expect((await store.getTerraform(id, "balanced"))?.code).toBe("resource x {}"); // untouched
  });

  it("setTerraform on an unknown id returns false", async () => {
    expect(await store.setTerraform("nope", "balanced", "x")).toBe(false);
  });
});
