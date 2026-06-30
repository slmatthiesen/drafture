import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, type Db, type Clock } from "./sqlite.js";
import { SqliteFeedbackStore } from "./feedback.js";

describe("SqliteFeedbackStore", () => {
  let db: Db;
  let store: SqliteFeedbackStore;

  beforeEach(() => {
    db = openTempDb();
    store = new SqliteFeedbackStore(db);
  });

  const base = {
    promptHash: "h1",
    description: "a notification system",
    answers: ["Expected traffic: High"],
    round: 2,
    recommendedTier: "balanced",
    body: '{"recommendedTier":"balanced"}',
    rating: 1 as 1 | -1,
    ip: "1.1.1.1",
    comment: null,
  };

  it("inserts a feedback entry with a generated id", async () => {
    const entry = await store.upsert(base);
    expect(entry.rating).toBe(1);
    expect(entry.promptHash).toBe("h1");
    expect(entry.id).toBeTruthy();
    expect(entry.recommendedTier).toBe("balanced");
  });

  it("updates (not stacks) a second vote from the same IP on the same design", async () => {
    await store.upsert({ ...base, rating: 1 });
    const updated = await store.upsert({ ...base, rating: -1 });
    expect(updated.rating).toBe(-1);
    // One row total, and its id is stable across the update.
    expect(await store.listByRating(1, 10)).toHaveLength(0);
    expect(await store.listByRating(-1, 10)).toEqual([expect.objectContaining({ id: updated.id })]);
  });

  it("keeps separate verdicts for different IPs on the same design", async () => {
    await store.upsert({ ...base, ip: "1.1.1.1", rating: 1 });
    await store.upsert({ ...base, ip: "2.2.2.2", rating: -1 });
    expect(await store.listByRating(1, 10)).toHaveLength(1);
    expect(await store.listByRating(-1, 10)).toHaveLength(1);
  });

  it("keeps separate verdicts for the same IP on different designs", async () => {
    await store.upsert({ ...base, promptHash: "h1", rating: 1 });
    await store.upsert({ ...base, promptHash: "h2", rating: -1 });
    expect(await store.listByRating(1, 10)).toHaveLength(1);
    expect(await store.listByRating(-1, 10)).toHaveLength(1);
  });

  it("round-trips answers + body through JSON", async () => {
    const entry = await store.upsert({ ...base, answers: ["a", "b"], body: '{"x":1}' });
    expect(entry.answers).toEqual(["a", "b"]);
    expect(entry.body).toBe('{"x":1}');
  });

  it("listByRating returns most-recently-updated first", async () => {
    let t = 1000;
    const clock: Clock = { now: () => (t += 10) };
    const s = new SqliteFeedbackStore(db, clock);
    await s.upsert({ ...base, promptHash: "h1", rating: -1 });
    await s.upsert({ ...base, promptHash: "h2", rating: -1 });
    expect((await s.listByRating(-1, 10)).map((e) => e.promptHash)).toEqual(["h2", "h1"]);
  });
});
