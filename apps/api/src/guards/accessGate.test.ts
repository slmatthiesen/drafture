import { describe, it, expect } from "vitest";
import Fastify, { type preHandlerHookHandler } from "fastify";
import { makeAccessGate } from "./accessGate.js";

async function appWithGate(gate: preHandlerHookHandler) {
  const app = Fastify({ logger: false });
  app.post("/t", { preHandler: gate }, async () => ({ ok: true }));
  return app;
}

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

describe("accessGate", () => {
  it("passes through (OFF) when credentials are unset", async () => {
    const app = await appWithGate(makeAccessGate({}));
    const res = await app.inject({ method: "POST", url: "/t" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects with 401 + WWW-Authenticate when no creds supplied", async () => {
    const app = await appWithGate(makeAccessGate({ user: "demo", pass: "s3cret" }));
    const res = await app.inject({ method: "POST", url: "/t" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Basic /);
    await app.close();
  });

  it("rejects wrong creds (401)", async () => {
    const app = await appWithGate(makeAccessGate({ user: "demo", pass: "s3cret" }));
    const res = await app.inject({
      method: "POST",
      url: "/t",
      headers: { authorization: basic("demo", "wrong") },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("passes with correct creds (200)", async () => {
    const app = await appWithGate(makeAccessGate({ user: "demo", pass: "s3cret" }));
    const res = await app.inject({
      method: "POST",
      url: "/t",
      headers: { authorization: basic("demo", "s3cret") },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a malformed Authorization header", async () => {
    const app = await appWithGate(makeAccessGate({ user: "demo", pass: "s3cret" }));
    const res = await app.inject({
      method: "POST",
      url: "/t",
      headers: { authorization: "Bearer abc" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
