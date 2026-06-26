import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { clientIp } from "./clientIp.js";

/**
 * Per-IP sliding-window rate limiter (KTD8). Third guard in the chain. Keyed by the
 * `clientIp` helper so it honors `CF-Connecting-IP` behind Cloudflare. A small
 * in-memory window keeps this dependency-light and deterministic for tests; a clone
 * runs one container, so process-local state is sufficient for V1.
 *
 * TODO(tokens/min): the plan also wants a tokens/min limiter. Requests/min is the
 * must-have abuse bound and is implemented here; tokens/min would require counting
 * the prompt's tokens before admission (LlmProvider.countTokens) and a second
 * windowed accumulator. Deferred — the hard input-token cap (inputCap.ts) plus the
 * per-IP daily cap and global ceiling already bound per-IP token spend.
 */
export interface RateLimitConfig {
  /** Max requests allowed per IP within the window. */
  max: number;
  windowMs: number;
}

export interface RateLimiter {
  preHandler: preHandlerHookHandler;
  /** Clear all windows (test/maintenance helper). */
  reset(): void;
}

export function makeRateLimit(
  cfg: RateLimitConfig,
  now: () => number = Date.now,
): RateLimiter {
  // ip -> ascending request timestamps still inside the window.
  const windows = new Map<string, number[]>();

  const preHandler: preHandlerHookHandler = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const ip = clientIp(req);
    const ts = now();
    const cutoff = ts - cfg.windowMs;

    const recent = (windows.get(ip) ?? []).filter((t) => t > cutoff);

    if (recent.length >= cfg.max) {
      windows.set(ip, recent);
      const oldest = recent[0] ?? ts;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + cfg.windowMs - ts) / 1000));
      return reply
        .code(429)
        .header("retry-after", retryAfterSec)
        .send({ error: "rate_limited", message: "Too many requests; slow down." });
    }

    recent.push(ts);
    windows.set(ip, recent);
  };

  return { preHandler, reset: () => windows.clear() };
}
