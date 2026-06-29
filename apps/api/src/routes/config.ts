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
 * Output budget for the reference-config call. Sized to fit a COMPLETE single-tier
 * HCL file: the old 2500 (and an interim 8000) truncated a real design — the
 * self-host budget tier carries the whole security floor (KMS, CloudTrail, 3 S3
 * buckets, CloudFront OAC, IAM, CloudWatch) and runs ~8k+ tokens — shipping a file
 * that won't `terraform plan`. Set to the provider's STREAMING_THRESHOLD so the call
 * streams (a non-streaming request this large risks the SDK HTTP timeout). The
 * provisional spend reserve is sized off this number; a cache HIT costs $0 and the
 * reserve reconciles to the actual (usually far smaller) output on a MISS.
 */
const CONFIG_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Strip a Markdown code fence the model wraps the HCL in (```hcl … ```), so the
 * artifact is valid Terraform, not a fenced snippet. We instruct plain HCL, but
 * models still fence it intermittently; this is the provider-agnostic backstop.
 * Removes a leading ```lang line and a trailing ``` line; leaves un-fenced output
 * untouched.
 */
export function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/;
  const m = fence.exec(trimmed);
  if (m) return m[1]!.trim();
  // Tolerate a missing closing fence (e.g. truncated output): drop just the opener.
  return trimmed.replace(/^```[^\n]*\n/, "").replace(/\n?```$/, "");
}

/**
 * Warning banner prepended to the generated HCL itself (before line 1), so the danger
 * travels WITH the file even after it's copied out of the UI's red banner. Plain `#`
 * comments = valid HCL, survive copy/paste into an editor or `terraform` run.
 */
const REFERENCE_WARNING_HEADER = `##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run \`terraform plan\`, set a billing budget — you own every resource it creates.
##############################################################################

`;

interface ConfigBody {
  tier: Tier;
  description?: string;
  /** Optional id of the persisted generation this tier belongs to (lazy Terraform cache). */
  generationId?: string;
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
    generationId: { type: "string", minLength: 1, maxLength: 128 },
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

  // (0) Long-lived Terraform cache on the generation row (lazy-persist). Survives the
  // 24h response cache and serves gallery pulls for $0 — the first config request for
  // a (generation, tier) pays; every later pull is a free read. The client supplies
  // generationId when the design was persisted; without it we fall through to the
  // normal on-demand + 24h-cache path.
  const tierName = typeof tier?.name === "string" ? tier.name : undefined;
  const generationId = body.generationId;
  if (generationId && tierName) {
    const stored = ctx.stores.generations.getTerraform(generationId, tierName);
    if (stored) {
      emit("ok", { cacheHit: true, costUsd: 0 });
      return reply.code(200).send({ format: FORMAT, code: stored.code });
    }
  }

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

    const responseBody = { format: FORMAT, code: REFERENCE_WARNING_HEADER + stripCodeFence(generated.result) };

    // Persist this tier's Terraform onto the generation row so future pulls are free.
    // Best-effort: a persist failure never breaks the artifact the user just paid for.
    if (generationId && tierName) {
      try {
        ctx.stores.generations.setTerraform(generationId, tierName, responseBody.code);
      } catch (err) {
        req.log.error({ err }, "terraform persist failed (non-fatal)");
      }
    }

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
