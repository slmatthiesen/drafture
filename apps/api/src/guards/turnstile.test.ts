import { describe, it, expect, vi } from "vitest";
import Fastify, { type preHandlerHookHandler } from "fastify";
import { makeTurnstileGuard, type FetchFn } from "./turnstile.js";

async function appWith(gate: preHandlerHookHandler) {
  const app = Fastify({ logger: false });
  app.post("/t", { preHandler: gate }, async () => ({ ok: true }));
  return app;
}

function fakeFetch(success: boolean, httpOk = true): FetchFn {
  return vi.fn(async () => ({
    ok: httpOk,
    json: async () => ({ success }),
  })) as unknown as FetchFn;
}

describe("turnstile", () => {
  it("passes through when disabled (no secret)", async () => {
    const app = await appWith(makeTurnstileGuard({}, fakeFetch(false)));
    const res = await app.inject({ method: "POST", url: "/t" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects (403) when token is missing", async () => {
    const app = await appWith(makeTurnstileGuard({ secret: "sk" }, fakeFetch(true)));
    const res = await app.inject({
      method: "POST",
      url: "/t",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("turnstile_required");
    await app.close();
  });

  it("rejects (403) when Cloudflare reports failure", async () => {
    const app = await appWith(makeTurnstileGuard({ secret: "sk" }, fakeFetch(false)));
    const res = await app.inject({
      method: "POST",
      url: "/t",
      headers: { "cf-turnstile-response": "bad-token" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("turnstile_failed");
    await app.close();
  });

  it("passes (200) with a valid token via header", async () => {
    const fetchFn = fakeFetch(true);
    const app = await appWith(makeTurnstileGuard({ secret: "sk" }, fetchFn));
    const res = await app.inject({
      method: "POST",
      url: "/t",
      headers: { "cf-turnstile-response": "good-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchFn).toHaveBeenCalledOnce();
    await app.close();
  });

  it("accepts a token from a body field", async () => {
    const app = await appWith(makeTurnstileGuard({ secret: "sk" }, fakeFetch(true)));
    const res = await app.inject({
      method: "POST",
      url: "/t",
      payload: { turnstileToken: "good-token" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("fails closed (403) when the verify call throws", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as FetchFn;
    const app = await appWith(makeTurnstileGuard({ secret: "sk" }, throwing));
    const res = await app.inject({
      method: "POST",
      url: "/t",
      headers: { "cf-turnstile-response": "good-token" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
