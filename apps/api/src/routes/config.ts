/**
 * POST /api/config (staff-architect reference artifact) — hands back ONE best-fit
 * reference-only Terraform (HCL) file for a single, already-generated tier. It is
 * generated on demand and cached so repeat requests cost nothing, respecting the
 * $5/day ceiling — not a multi-format export buffet.
 *
 * Guard order mirrors /api/generate's friction chain but is DELIBERATELY lighter:
 *   access gate → Turnstile → per-IP rate limit → input-token cap
 *   ... then inside the handler ... → ResponseCache lookup → global daily-spend reserve.
 *
 * WHY config skips the per-IP daily generation cap but NOT the spend ceiling: a
 * config request is a follow-on to a generation the user has ALREADY paid for with
 * a per-IP slot, so charging a second slot would penalize finishing the workflow.
 * The global dollar ceiling, by contrast, is the real cost backstop (KTD8) and a
 * config call still spends real tokens, so it must reserve against the ceiling on
 * a cache MISS — and, like generate, a cache HIT skips the reserve entirely (zero
 * tokens, zero dollars).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import type { AppContext } from "../app/context.js";
import type { Usage } from "../llm/provider.js";
import type { Tier } from "../schema/architecture.js";

import { assertWithinInputBudget } from "../guards/inputCap.js";
import { llmCostUsd, provisionalLlmCostUsd, reserveSpend } from "../guards/spend.js";

import { hashPrompt } from "../store/responseCache.js";
import { emitTelemetry, telemetryRecord } from "../obs/telemetry.js";

const ROUTE = "/api/config";
const FORMAT = "terraform";

/**
 * Output budget for the bounded reference-config call. Kept small (matches the
 * provider default) so the on-demand artifact stays cheap; the provisional spend
 * reserve is sized off this same number to avoid over-reserving against the ceiling.
 */
const CONFIG_MAX_OUTPUT_TOKENS = 2500;

interface ConfigBody {
  tier: Tier;
  description?: string;
  turnstileToken?: string;
}

/**
 * Body validation (R-validation): `tier` is required and must be an object — a
 * missing or non-object tier is a 400 with Fastify's default validation message.
 * The tier is shape-validated only shallowly here; the provider serializes it.
 */
const configBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tier"],
  properties: {
    tier: { type: "object" },
    description: { type: "string", maxLength: 50_000 },
    turnstileToken: { type: "string" },
  },
} as const;

export async function registerConfigRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Hard input-token cap on the serialized tier — bounds the input bill the same
  // way /api/generate does, after validation has confirmed the body is well-typed.
  const inputCap: preHandlerHookHandler = async (req, reply) => {
    const body = req.body as ConfigBody;
    const text = JSON.stringify(body.tier);
    const verdict = await assertWithinInputBudget(ctx.provider, text, ctx.config.LLM_MAX_INPUT_TOKENS);
    if (!verdict.ok) {
      return reply.code(verdict.statusCode).send({
        error: "input_too_large",
        message: verdict.message,
        tokens: verdict.tokens,
        max: verdict.max,
      });
    }
  };

  app.post(
    ROUTE,
    {
      schema: { body: configBodySchema },
      // No daily-cap guard here: config is a follow-on to an already-counted
      // generation (see file header). Spend is still bounded by the ceiling reserve.
      preHandler: [
        ctx.guards.accessGate,
        ctx.guards.turnstile,
        ctx.guards.rateLimit.preHandler,
        inputCap,
      ],
    },
    (req, reply) => handleConfig(ctx, req, reply),
  );
}

async function handleConfig(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const startedAt = Date.now();
  const requestId = req.id;
  const body = req.body as ConfigBody;
  const tier = body.tier;

  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const addUsage = (u: Usage): void => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
  };

  const emit = (outcome: string, opts: { cacheHit?: boolean; costUsd?: number } = {}): void => {
    emitTelemetry(
      telemetryRecord({
        requestId,
        route: ROUTE,
        cacheHit: opts.cacheHit ?? false,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        latencyMs: Date.now() - startedAt,
        costUsd: opts.costUsd ?? 0,
        outcome,
      }),
      ctx.telemetrySink,
    );
  };

  // Cache key: the tier graph + the artifact format. The same tier always yields the
  // same reference config, so an identical request is served free from cache.
  const cacheKey = hashPrompt({ tier, format: FORMAT });

  // (1) ResponseCache lookup. HIT short-circuits: no spend, costUsd 0 (KTD8).
  const cached = ctx.stores.responseCache.get(cacheKey, ctx.config.RESPONSE_CACHE_TTL_MS);
  if (cached) {
    emit("ok", { cacheHit: true, costUsd: 0 });
    return reply.code(200).send(JSON.parse(cached.body));
  }

  // (2) Reserve against the global daily ceiling BEFORE the real call (KTD7). The
  // provisional is sized off this route's small output budget, not the full
  // generation budget, so config calls don't over-reserve. No per-IP cap here.
  const provisional = provisionalLlmCostUsd(
    ctx.pricing,
    ctx.config.LLM_MAX_INPUT_TOKENS,
    CONFIG_MAX_OUTPUT_TOKENS,
  );
  const reservation = reserveSpend(ctx.stores.spendLedger, provisional, ctx.config.DAILY_SPEND_CEILING_USD);
  if (!reservation.ok || !reservation.reservation) {
    emit("refused", { costUsd: 0 });
    // 503: cost ceiling reached for NEW work; cached configs still serve.
    return reply.code(503).send({
      error: "daily_budget_reached",
      message: reservation.message,
      spentTodayUsd: reservation.spentTodayUsd,
      ceilingUsd: reservation.ceilingUsd,
    });
  }
  const reservationId = reservation.reservation.reservationId;

  try {
    const generated = await ctx.provider.generateConfig(tier, { maxTokens: CONFIG_MAX_OUTPUT_TOKENS });
    addUsage(generated.usage);

    // Reconcile the provisional reserve to the ACTUAL measured cost (KTD7).
    const actualUsd = llmCostUsd(usage, ctx.pricing);
    ctx.stores.spendLedger.reconcile(reservationId, actualUsd);

    const responseBody = { format: FORMAT, code: generated.result };
    ctx.stores.responseCache.set(cacheKey, JSON.stringify(responseBody));

    emit("ok", { costUsd: actualUsd });
    return reply.code(200).send(responseBody);
  } catch (err) {
    // The call produced nothing — release the reservation so no budget lingers.
    ctx.stores.spendLedger.release(reservationId);
    emit("error", { costUsd: 0 });
    req.log.error({ err }, "config generation failed");
    return reply.code(502).send({
      error: "config_generation_failed",
      message: "The config service is temporarily unavailable. Please try again.",
    });
  }
}
