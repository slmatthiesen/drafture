import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type Config } from "../config.js";
import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { hashPrompt } from "../store/responseCache.js";
import { buildAppContext, registerApiRoutes, type AppContext } from "../app/context.js";

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    ANTHROPIC_API_KEY: "test-key",
    NODE_ENV: "test",
    DB_PATH: ":memory:",
    ...overrides,
  });
}

async function buildHarness(
  configOverrides: Record<string, string> = {},
): Promise<{ app: FastifyInstance; ctx: AppContext; stores: Stores }> {
  const stores = createStores(openTempDb());
  const ctx = buildAppContext(testConfig(configOverrides), { stores });
  const app = Fastify({ logger: false, trustProxy: true });
  await registerApiRoutes(app, ctx);
  return { app, ctx, stores };
}

describe("POST /api/feedback", () => {
  it("records a down-vote and echoes the rating", async () => {
    const { app } = await buildHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { description: "a notification system", round: 2, rating: -1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rating: -1 });
    await app.close();
  });

  it("re-derives the generate cache key and snapshots the rated body", async () => {
    const { app, ctx, stores } = await buildHarness();
    const description = "a notification system";
    const answers = ["Expected traffic: High"];
    const round = 2;
    // The EXACT hash /api/generate uses as its response-cache key.
    const promptHash = hashPrompt({
      description,
      answers,
      round,
      model: ctx.config.LLM_MODEL,
      region: ctx.config.DEFAULT_REGION,
    });
    // Seed the cache exactly as /api/generate would after a real generation.
    stores.responseCache.set(promptHash, JSON.stringify({ recommendedTier: "balanced", tiers: [] }));

    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { description, answers, round, rating: -1 },
    });
    expect(res.statusCode).toBe(200);

    const entry = stores.feedback.listByRating(-1, 10)[0]!;
    expect(entry.promptHash).toBe(promptHash);
    expect(entry.recommendedTier).toBe("balanced");
    expect(entry.body).toContain('"balanced"');
    await app.close();
  });

  it("updates (not stacks) a repeated vote from one IP", async () => {
    const { app, stores } = await buildHarness();
    const body = { description: "x", round: 2 };
    await app.inject({ method: "POST", url: "/api/feedback", payload: { ...body, rating: 1 } });
    await app.inject({ method: "POST", url: "/api/feedback", payload: { ...body, rating: -1 } });
    expect(stores.feedback.listByRating(1, 10)).toHaveLength(0);
    expect(stores.feedback.listByRating(-1, 10)).toHaveLength(1);
    await app.close();
  });

  it("rejects an out-of-enum rating with 400", async () => {
    const { app } = await buildHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { description: "x", rating: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a missing description with 400", async () => {
    const { app } = await buildHarness();
    const res = await app.inject({ method: "POST", url: "/api/feedback", payload: { rating: 1 } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("applies the per-IP rate limit (429)", async () => {
    const { app } = await buildHarness({ RATE_LIMIT_MAX: "1" });
    const ok = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { description: "x", rating: 1 },
    });
    expect(ok.statusCode).toBe(200);
    const limited = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { description: "x", rating: 1 },
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });
});
