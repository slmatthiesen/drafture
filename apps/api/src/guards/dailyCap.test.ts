import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import { makeDailyCap } from "./dailyCap.js";

let stores: Stores;

beforeEach(() => {
  stores = createStores(openTempDb());
});

async function appWith(preHandler: ReturnType<typeof makeDailyCap>["preHandler"]) {
  const app = Fastify({ logger: false, trustProxy: true });
  app.post("/t", { preHandler }, async () => ({ ok: true }));
  return app;
}

describe("dailyCap", () => {
  it("checkIpCap rejects once the IP is at the limit", async () => {
    const cap = makeDailyCap(stores.spendLedger, { maxPerDay: 2 });
    expect((await cap.checkIpCap("1.1.1.1")).ok).toBe(true);
    await cap.recordIpGeneration("1.1.1.1");
    await cap.recordIpGeneration("1.1.1.1");
    expect((await cap.checkIpCap("1.1.1.1")).ok).toBe(false);
    expect((await cap.checkIpCap("1.1.1.1")).countToday).toBe(2);
  });

  it("preHandler 429s an IP at the cap; other IPs unaffected", async () => {
    const cap = makeDailyCap(stores.spendLedger, { maxPerDay: 1 });
    await cap.recordIpGeneration("1.1.1.1");
    const app = await appWith(cap.preHandler);

    const blocked = await app.inject({
      method: "POST",
      url: "/t",
      headers: { "cf-connecting-ip": "1.1.1.1" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("daily_cap_reached");

    const other = await app.inject({
      method: "POST",
      url: "/t",
      headers: { "cf-connecting-ip": "2.2.2.2" },
    });
    expect(other.statusCode).toBe(200);
    await app.close();
  });

  it("a cache hit does NOT consume the cap (record is not called)", async () => {
    // Simulating U9's contract: on a cache hit the route must skip recordIpGeneration.
    const cap = makeDailyCap(stores.spendLedger, { maxPerDay: 1 });
    // 5 "requests" that all hit cache → no record calls → cap never consumed.
    for (let i = 0; i < 5; i++) {
      expect((await cap.checkIpCap("1.1.1.1")).ok).toBe(true);
      // (no recordIpGeneration — cached path)
    }
    expect((await cap.checkIpCap("1.1.1.1")).ok).toBe(true);
  });
});
