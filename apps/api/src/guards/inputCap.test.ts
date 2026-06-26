import { describe, it, expect, vi } from "vitest";
import { assertWithinInputBudget } from "./inputCap.js";

function provider(tokens: number) {
  return { countTokens: vi.fn(async () => tokens) };
}

describe("assertWithinInputBudget", () => {
  it("ok when at or below the cap", async () => {
    const res = await assertWithinInputBudget(provider(100), "hello", 100);
    expect(res.ok).toBe(true);
    expect(res.tokens).toBe(100);
    expect(res.message).toBeUndefined();
  });

  it("rejects above the cap with a 413-shaped result", async () => {
    const res = await assertWithinInputBudget(provider(13_000), "big", 12_000);
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(413);
    expect(res.max).toBe(12_000);
    expect(res.message).toContain("too large");
  });
});
