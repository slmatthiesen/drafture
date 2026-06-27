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

  it("inserts a feedback entry with a generated id", () => {
    const entry = store.upsert(base);
    expect(entry.rating).toBe(1);
    expect(entry.promptHash).toBe("h1");
    expect(entry.id).toBeTruthy();
    expect(entry.recommendedTier).toBe("balanced");
  });

  it("updates (not stacks) a second vote from the same IP on the same design", () => {
    store.upsert({ ...base, rating: 1 });
    const updated = store.upsert({ ...base, rating: -1 });
    expect(updated.rating).toBe(-1);
    // One row total, and its id is stable across the update.
    expect(store.listByRating(1, 10)).toHaveLength(0);
    expect(store.listByRating(-1, 10)).toEqual([expect.objectContaining({ id: updated.id })]);
  });

  it("keeps separate verdicts for different IPs on the same design", () => {
    store.upsert({ ...base, ip: "1.1.1.1", rating: 1 });
    store.upsert({ ...base, ip: "2.2.2.2", rating: -1 });
    expect(store.listByRating(1, 10)).toHaveLength(1);
    expect(store.listByRating(-1, 10)).toHaveLength(1);
  });

  it("keeps separate verdicts for the same IP on different designs", () => {
    store.upsert({ ...base, promptHash: "h1", rating: 1 });
    store.upsert({ ...base, promptHash: "h2", rating: -1 });
    expect(store.listByRating(1, 10)).toHaveLength(1);
    expect(store.listByRating(-1, 10)).toHaveLength(1);
  });

  it("round-trips answers + body through JSON", () => {
    const entry = store.upsert({ ...base, answers: ["a", "b"], body: '{"x":1}' });
    expect(entry.answers).toEqual(["a", "b"]);
    expect(entry.body).toBe('{"x":1}');
  });

  it("listByRating returns most-recently-updated first", () => {
    let t = 1000;
    const clock: Clock = { now: () => (t += 10) };
    const s = new SqliteFeedbackStore(db, clock);
    s.upsert({ ...base, promptHash: "h1", rating: -1 });
    s.upsert({ ...base, promptHash: "h2", rating: -1 });
    expect(s.listByRating(-1, 10).map((e) => e.promptHash)).toEqual(["h2", "h1"]);
  });
});
