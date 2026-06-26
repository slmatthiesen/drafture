import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { makeRateLimit } from "./rateLimit.js";

async function appWith(limiterPreHandler: ReturnType<typeof makeRateLimit>["preHandler"]) {
  const app = Fastify({ logger: false, trustProxy: true });
  app.post("/t", { preHandler: limiterPreHandler }, async () => ({ ok: true }));
  return app;
}

function inject(app: Awaited<ReturnType<typeof appWith>>, ip: string) {
  return app.inject({
    method: "POST",
    url: "/t",
    headers: { "cf-connecting-ip": ip },
  });
}

describe("rateLimit", () => {
  it("allows up to max, then 429s the (max+1)th request from one IP", async () => {
    const limiter = makeRateLimit({ max: 3, windowMs: 60_000 });
    const app = await appWith(limiter.preHandler);
    for (let i = 0; i < 3; i++) {
      const res = await inject(app, "1.1.1.1");
      expect(res.statusCode).toBe(200);
    }
    const blocked = await inject(app, "1.1.1.1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("isolates IPs — another IP is unaffected", async () => {
    const limiter = makeRateLimit({ max: 1, windowMs: 60_000 });
    const app = await appWith(limiter.preHandler);
    expect((await inject(app, "1.1.1.1")).statusCode).toBe(200);
    expect((await inject(app, "1.1.1.1")).statusCode).toBe(429);
    expect((await inject(app, "2.2.2.2")).statusCode).toBe(200);
    await app.close();
  });

  it("permits again once the window slides past old hits", async () => {
    let t = 1_000_000;
    const limiter = makeRateLimit({ max: 1, windowMs: 1_000 }, () => t);
    const app = await appWith(limiter.preHandler);
    expect((await inject(app, "1.1.1.1")).statusCode).toBe(200);
    expect((await inject(app, "1.1.1.1")).statusCode).toBe(429);
    t += 1_500; // advance past the window
    expect((await inject(app, "1.1.1.1")).statusCode).toBe(200);
    await app.close();
  });
});
