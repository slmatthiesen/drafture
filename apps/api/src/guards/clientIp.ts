import type { FastifyRequest } from "fastify";

/**
 * Derive the real client IP for rate-limit / per-IP-cap keying.
 *
 * Order matters for spoof-resistance behind Cloudflare (KTD8): Cloudflare sets
 * `CF-Connecting-IP` to the verified edge client and strips inbound copies, so it
 * is the most trustworthy hop. We fall back to the first `X-Forwarded-For` hop
 * (the original client when a chain of proxies is honest) and finally to Fastify's
 * own `req.ip` (which already respects `trustProxy`).
 *
 * NOTE: when exposed directly (no Cloudflare), `X-Forwarded-For` is client-spoofable;
 * the per-IP cap is therefore friction, not the hard guarantee — the global spend
 * ceiling is the real backstop (KTD8).
 */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();

  const xff = req.headers["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  if (typeof xffStr === "string") {
    const firstHop = xffStr.split(",")[0]?.trim();
    if (firstHop) return firstHop;
  }

  return req.ip;
}
