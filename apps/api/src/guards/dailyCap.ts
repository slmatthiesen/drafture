import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { SpendLedger } from "../store/types.js";
import { clientIp } from "./clientIp.js";

/**
 * Per-IP daily generation cap (KTD8). Fourth guard in the chain — runs BEFORE the
 * response-cache lookup as a read-only reject, then U9 calls `recordIpGeneration`
 * only AFTER a cache miss commits to an actual generation.
 *
 * Why split check from record: a cached hit must NOT consume the cap (KTD8 — the
 * tool stays usable on cache for the rest of the day). So the preHandler only
 * rejects an IP already AT the limit; the increment happens later, post-cache-miss,
 * so cached hits and rejected requests never burn a generation.
 */
export interface DailyCapConfig {
  maxPerDay: number;
}

export interface DailyCapCheck {
  ok: boolean;
  countToday: number;
  max: number;
}

export interface DailyCap {
  /** Read-only: ok=false when this IP has already used its daily allotment. */
  checkIpCap(ip: string): Promise<DailyCapCheck>;
  /** Count a generation that will actually run (call AFTER the cache-miss decision). */
  recordIpGeneration(ip: string): Promise<number>;
  /** preHandler form of `checkIpCap` keyed by the clientIp helper. */
  preHandler: preHandlerHookHandler;
}

export function makeDailyCap(ledger: SpendLedger, cfg: DailyCapConfig): DailyCap {
  async function checkIpCap(ip: string): Promise<DailyCapCheck> {
    const countToday = await ledger.ipCountToday(ip);
    return { ok: countToday < cfg.maxPerDay, countToday, max: cfg.maxPerDay };
  }

  async function recordIpGeneration(ip: string): Promise<number> {
    return ledger.incrementIpCount(ip);
  }

  const preHandler: preHandlerHookHandler = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const { ok, countToday, max } = await checkIpCap(clientIp(req));
    if (!ok) {
      return reply.code(429).send({
        error: "daily_cap_reached",
        message: `Daily generation limit reached (${max}/day). Cached results are still available; try again tomorrow.`,
        countToday,
        max,
      });
    }
  };

  return { checkIpCap, recordIpGeneration, preHandler };
}
