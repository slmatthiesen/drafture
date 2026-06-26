import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { clientIp } from "./clientIp.js";

async function appEchoingIp() {
  const app = Fastify({ logger: false, trustProxy: true });
  app.post("/t", async (req) => ({ ip: clientIp(req) }));
  return app;
}

describe("clientIp", () => {
  it("prefers CF-Connecting-IP over X-Forwarded-For", async () => {
    const app = await appEchoingIp();
    const res = await app.inject({
      method: "POST",
      url: "/t",
      headers: {
        "cf-connecting-ip": "9.9.9.9",
        "x-forwarded-for": "1.1.1.1, 2.2.2.2",
      },
    });
    expect(res.json().ip).toBe("9.9.9.9");
    await app.close();
  });

  it("falls back to the first X-Forwarded-For hop", async () => {
    const app = await appEchoingIp();
    const res = await app.inject({
      method: "POST",
      url: "/t",
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" },
    });
    expect(res.json().ip).toBe("1.1.1.1");
    await app.close();
  });

  it("falls back to req.ip when no proxy headers are present", async () => {
    const app = await appEchoingIp();
    const res = await app.inject({ method: "POST", url: "/t" });
    expect(typeof res.json().ip).toBe("string");
    expect(res.json().ip.length).toBeGreaterThan(0);
    await app.close();
  });
});
