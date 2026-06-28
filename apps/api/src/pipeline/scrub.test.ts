import { describe, it, expect } from "vitest";

import { scrubPrompt, scrubAll } from "./scrub.js";

describe("scrubPrompt", () => {
  it("leaves ordinary architecture text untouched", () => {
    const r = scrubPrompt("Build a realtime chat backend with websockets");
    expect(r.wasRedacted).toBe(false);
    expect(r.text).toBe("Build a realtime chat backend with websockets");
  });

  it("redacts an AWS access key id", () => {
    const r = scrubPrompt("deploy with key AKIAIOSFODNN7EXAMPLE please");
    expect(r.wasRedacted).toBe(true);
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.text).toContain("[REDACTED]");
  });

  it("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEF\n-----END RSA PRIVATE KEY-----";
    const r = scrubPrompt(`use this cert ${pem} for mTLS`);
    expect(r.wasRedacted).toBe(true);
    expect(r.text).not.toContain("MIIBVwIBADANBgkqhkiG9w0BAQEF");
    expect(r.text).toContain("[REDACTED]");
  });

  it("redacts secret/password/token assignments", () => {
    const r = scrubPrompt("db password=hunter2secret and api_key=sk_live_AbCdEf12345 done");
    expect(r.wasRedacted).toBe(true);
    expect(r.text).not.toContain("hunter2secret");
    expect(r.text).not.toContain("sk_live_AbCdEf12345");
  });

  it("preserves the surrounding architectural intent", () => {
    const r = scrubPrompt("Build a payments API. password=hunter2secret It must be PCI-compliant.");
    expect(r.text).toContain("Build a payments API.");
    expect(r.text).toContain("It must be PCI-compliant.");
  });

  it("ignores trivially short values (not a real secret)", () => {
    // value too short to match the {7,} body — intent preserved, no redaction
    const r = scrubPrompt("password=abc");
    expect(r.wasRedacted).toBe(false);
  });

  it("is idempotent (scrubbing the placeholder is a no-op)", () => {
    const once = scrubPrompt("key AKIAIOSFODNN7EXAMPLE here");
    const twice = scrubPrompt(once.text);
    expect(twice.wasRedacted).toBe(false);
    expect(twice.text).toBe(once.text);
  });
});

describe("scrubAll", () => {
  it("scrubs a list and reports if any redacted", () => {
    const r = scrubAll(["no secrets", "token=abcdef12345"]);
    expect(r.wasRedacted).toBe(true);
    expect(r.texts[0]).toBe("no secrets");
    expect(r.texts[1]).toContain("[REDACTED]");
  });

  it("reports no redaction when clean", () => {
    const r = scrubAll(["realtime", "high traffic"]);
    expect(r.wasRedacted).toBe(false);
  });
});
