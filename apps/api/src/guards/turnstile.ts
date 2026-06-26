import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { clientIp } from "./clientIp.js";

/**
 * Cloudflare Turnstile bot check (KTD8). ENABLED only when a secret is configured;
 * otherwise passes through. Fails CLOSED on a missing/invalid token or a verify
 * outage — a CAPTCHA that opens under failure is no CAPTCHA. Like the access gate
 * this is friction, not the cost guarantee.
 */
export interface TurnstileConfig {
  secret?: string;
}

/** Injectable so tests can mock the network call without hitting Cloudflare. */
export type FetchFn = typeof fetch;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success?: boolean;
}

/** Read the client token from the documented header or a request-body field. */
function extractToken(req: FastifyRequest): string | undefined {
  const header = req.headers["cf-turnstile-response"];
  if (typeof header === "string" && header) return header;

  const body = req.body;
  if (body && typeof body === "object") {
    const fields = body as Record<string, unknown>;
    const candidate = fields["turnstileToken"] ?? fields["cf-turnstile-response"];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

/** POST the token to Cloudflare's siteverify endpoint; true only on `success`. */
export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string,
  fetchFn: FetchFn = fetch,
): Promise<boolean> {
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const res = await fetchFn(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch {
    return false; // fail closed on a transport/parse error
  }
}

/** Factory → Fastify preHandler. Second guard in the chain (after access gate). */
export function makeTurnstileGuard(
  cfg: TurnstileConfig,
  fetchFn: FetchFn = fetch,
): preHandlerHookHandler {
  const { secret } = cfg;
  const enabled = Boolean(secret);

  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!enabled || !secret) return; // disabled — pass through

    const token = extractToken(req);
    if (!token) {
      return reply
        .code(403)
        .send({ error: "turnstile_required", message: "Bot-check token missing." });
    }

    const ok = await verifyTurnstile(secret, token, clientIp(req), fetchFn);
    if (!ok) {
      return reply
        .code(403)
        .send({ error: "turnstile_failed", message: "Bot-check verification failed." });
    }
  };
}
