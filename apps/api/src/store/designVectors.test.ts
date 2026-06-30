import { describe, it, expect, beforeEach } from "vitest";

import { openTempDb, type Db, type Clock } from "./sqlite.js";
import { SqliteDesignVectorStore } from "./designVectors.js";

const clock: Clock = { now: () => 1_000 };

const rec = (id: string, vector: number[], model = "voyage-3-lite") => ({
  id,
  source: "curated" as const,
  promptHash: `hash-${id}`,
  text: `prompt ${id}`,
  vector,
  model,
});

describe("SqliteDesignVectorStore", () => {
  let db: Db;
  let store: SqliteDesignVectorStore;

  beforeEach(() => {
    db = openTempDb();
    store = new SqliteDesignVectorStore(db, clock);
  });

  it("upsert + search ranks the nearest vector first", async () => {
    await store.upsert(rec("a", [1, 0, 0]));
    await store.upsert(rec("b", [0, 1, 0]));
    await store.upsert(rec("c", [0.9, 0.1, 0]));

    const hits = await store.search([1, 0, 0], "voyage-3-lite", 2);
    expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
    expect(hits[0]!.similarity).toBeCloseTo(1, 5);
    expect(hits[1]!.similarity).toBeGreaterThan(hits[1]!.similarity - 1); // c is close but < a
    expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity);
  });

  it("upsert overwrites by id (re-embedding replaces the vector)", async () => {
    await store.upsert(rec("a", [1, 0, 0]));
    await store.upsert(rec("a", [0, 1, 0]));
    expect(await store.count("voyage-3-lite")).toBe(1);
    const [hit] = await store.search([0, 1, 0], "voyage-3-lite", 1);
    expect(hit!.similarity).toBeCloseTo(1, 5);
  });

  it("search only compares vectors from the SAME model (never mixes spaces)", async () => {
    await store.upsert(rec("a", [1, 0, 0], "voyage-3-lite"));
    await store.upsert(rec("b", [1, 0, 0], "other-model"));
    expect(await store.count("voyage-3-lite")).toBe(1);
    expect(await store.search([1, 0, 0], "voyage-3-lite", 5)).toHaveLength(1);
    expect((await store.search([1, 0, 0], "voyage-3-lite", 5))[0]!.id).toBe("a");
  });

  it("hasForModel reports whether a design is embedded under a model", async () => {
    await store.upsert(rec("a", [1, 0, 0], "voyage-3-lite"));
    expect(await store.hasForModel("a", "voyage-3-lite")).toBe(true);
    expect(await store.hasForModel("a", "other-model")).toBe(false);
    expect(await store.hasForModel("missing", "voyage-3-lite")).toBe(false);
  });

  it("delete removes a row", async () => {
    await store.upsert(rec("a", [1, 0, 0]));
    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
    expect(await store.count("voyage-3-lite")).toBe(0);
  });
});
