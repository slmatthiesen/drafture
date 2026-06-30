import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "../config.js";
import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { buildAppContext, registerApiRoutes } from "../app/context.js";

function testConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({ ANTHROPIC_API_KEY: "test-key", NODE_ENV: "test", DB_PATH: ":memory:" });
}

const DESIGN = { recommendedTier: "balanced", tiers: [], assumptions: [] };

async function buildHarness(): Promise<{ app: FastifyInstance; stores: Stores }> {
  const stores = createStores(openTempDb());
  // No provider override needed: the curated routes never call the model. The real
  // provider is constructed but idle (the test ANTHROPIC_API_KEY is never used).
  const ctx = await buildAppContext(testConfig(), { stores });
  const app = Fastify({ logger: false, trustProxy: true });
  await registerApiRoutes(app, ctx);
  return { app, stores };
}

const FROM_IP = (ip: string) => ({ "x-forwarded-for": ip });

describe("curated routes", () => {
  let app: FastifyInstance;
  let stores: Stores;

  beforeEach(async () => {
    ({ app, stores } = await buildHarness());
    await stores.curated.upsert({ id: "alpha", title: "Alpha", prompt: "p", body: JSON.stringify(DESIGN) });
  });

  it("GET /api/curated lists summaries without the body", async () => {
    const res = await app.inject({ method: "GET", url: "/api/curated" });
    expect(res.statusCode).toBe(200);
    const { runs } = res.json();
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("alpha");
    expect(runs[0].body).toBeUndefined();
    await app.close();
  });

  it("GET /api/curated/:id returns the parsed design", async () => {
    const res = await app.inject({ method: "GET", url: "/api/curated/alpha" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe("Alpha");
    expect(body.design).toEqual(DESIGN);
    await app.close();
  });

  it("GET /api/curated/:id 404s for an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/curated/nope" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST vote increments and returns new counts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/curated/alpha/vote",
      headers: FROM_IP("1.1.1.1"),
      payload: { value: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ upvotes: 1, downvotes: 0 });
    await app.close();
  });

  it("the same IP voting twice replaces its vote (no ballot stuffing)", async () => {
    await app.inject({ method: "POST", url: "/api/curated/alpha/vote", headers: FROM_IP("2.2.2.2"), payload: { value: 1 } });
    const second = await app.inject({ method: "POST", url: "/api/curated/alpha/vote", headers: FROM_IP("2.2.2.2"), payload: { value: -1 } });
    expect(second.json()).toEqual({ upvotes: 0, downvotes: 1 });
    await app.close();
  });

  it("POST vote 404s for an unknown run", async () => {
    const res = await app.inject({ method: "POST", url: "/api/curated/nope/vote", headers: FROM_IP("3.3.3.3"), payload: { value: 1 } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST vote rejects an invalid value with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/curated/alpha/vote", headers: FROM_IP("4.4.4.4"), payload: { value: 5 } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
