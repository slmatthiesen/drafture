import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig } from "../config.js";
import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { buildAppContext, registerApiRoutes } from "../app/context.js";

function testConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({ ANTHROPIC_API_KEY: "test-key", NODE_ENV: "test", DB_PATH: ":memory:" });
}

const DESIGN = { recommendedTier: "balanced", tiers: [], assumptions: [] };

const genInput = (promptHash: string) => ({
  promptHash,
  description: "build a chat app",
  answers: [],
  model: "claude-sonnet-4-6",
  region: "us-east-1",
  recommendedTier: "balanced",
  tags: ["messaging"],
  body: JSON.stringify(DESIGN),
  clientIp: "1.1.1.1",
});

async function buildHarness(): Promise<{ app: FastifyInstance; stores: Stores }> {
  const stores = createStores(openTempDb());
  // No provider override needed: the designs GET never calls the model. The real
  // provider is constructed but idle (the test ANTHROPIC_API_KEY is never used).
  const ctx = await buildAppContext(testConfig(), { stores });
  const app = Fastify({ logger: false, trustProxy: true });
  await registerApiRoutes(app, ctx);
  return { app, stores };
}

describe("designs routes — GET /api/designs/:id", () => {
  let app: FastifyInstance;
  let stores: Stores;
  let id: string;

  beforeEach(async () => {
    ({ app, stores } = await buildHarness());
    ({ id } = await stores.generations.upsert(genInput("hash1")));
  });

  it("returns the parsed design + prompt for an approved id", async () => {
    await stores.generations.setStatus(id, "approved");
    const res = await app.inject({ method: "GET", url: `/api/designs/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.prompt).toBe("build a chat app");
    expect(body.design).toEqual(DESIGN);
    await app.close();
  });

  it("404s for an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/designs/nope" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s for a pending design (not yet approved — never public)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/designs/${id}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s for a hidden design (community-removed — never public)", async () => {
    await stores.generations.setStatus(id, "hidden");
    const res = await app.inject({ method: "GET", url: `/api/designs/${id}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("designs routes — GET /api/designs (community gallery list)", () => {
  let app: FastifyInstance;
  let stores: Stores;

  beforeEach(async () => {
    ({ app, stores } = await buildHarness());
  });

  it("lists only approved designs — pending and hidden are excluded", async () => {
    const approved = await stores.generations.upsert(genInput("h-approved"));
    const pending = await stores.generations.upsert(genInput("h-pending"));
    const hidden = await stores.generations.upsert(genInput("h-hidden"));
    await stores.generations.setStatus(approved.id, "approved");
    await stores.generations.setStatus(hidden.id, "hidden");
    // `pending` is left in its default pending status.

    const res = await app.inject({ method: "GET", url: "/api/designs" });
    expect(res.statusCode).toBe(200);
    const ids = res.json().designs.map((d: { id: string }) => d.id);
    expect(ids).toEqual([approved.id]);
    expect(ids).not.toContain(pending.id);
    expect(ids).not.toContain(hidden.id);
    await app.close();
  });

  it("returns gallery summary fields and an empty list when nothing is approved", async () => {
    const empty = await app.inject({ method: "GET", url: "/api/designs" });
    expect(empty.json().designs).toEqual([]);

    const { id } = await stores.generations.upsert(genInput("h-summary"));
    await stores.generations.setStatus(id, "approved");
    const res = await app.inject({ method: "GET", url: "/api/designs" });
    const design = res.json().designs[0];
    expect(design).toMatchObject({
      id,
      description: "build a chat app",
      recommendedTier: "balanced",
      tags: ["messaging"],
      model: "claude-sonnet-4-6",
    });
    expect(typeof design.upvotes).toBe("number");
    expect(typeof design.createdAt).toBe("number");
    await app.close();
  });
});
