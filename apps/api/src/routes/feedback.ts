/**
 * POST /api/feedback — record a thumbs-up/down on a generated design.
 *
 * The body carries the original prompt inputs (description + answers + round) plus a
 * rating (±1). The server re-derives the SAME prompt hash /api/generate uses as its
 * response-cache key — `hashPrompt({description, answers, round, model, region})` — so
 * the verdict is tied to the exact prompt→output pair and the client can't mismatch it.
 * The rated output is snapshotted from the response cache (when still present) so the
 * operator review script is self-contained.
 *
 * Public + anonymous: only the per-IP rate limiter guards it (no Turnstile/access gate —
 * feedback should be frictionless). One verdict per (IP, design): the store's UPSERT
 * changes a prior vote rather than stacking. No LLM call → no spend, no telemetry cost.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppContext } from "../app/context.js";
import { clientIp } from "../guards/clientIp.js";
import { hashPrompt } from "../store/responseCache.js";

const ROUTE = "/api/feedback";

interface FeedbackBody {
  description: string;
  answers?: string[];
  round?: number;
  rating: 1 | -1;
}

const feedbackBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["description", "rating"],
  properties: {
    description: { type: "string", minLength: 1, maxLength: 50_000 },
    answers: { type: "array", maxItems: 16, items: { type: "string" } },
    round: { type: "integer", minimum: 0, maximum: 8 },
    // Only ±1 — anything else is a validation 400.
    rating: { type: "integer", enum: [1, -1] },
  },
} as const;

export async function registerFeedbackRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post(
    ROUTE,
    {
      schema: { body: feedbackBodySchema },
      preHandler: [ctx.guards.rateLimit.preHandler],
    },
    (req, reply) => handleFeedback(ctx, req, reply),
  );
}

function handleFeedback(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): unknown {
  const body = req.body as FeedbackBody;
  const ip = clientIp(req);

  // Re-derive the EXACT cache key /api/generate uses (same inputs, same order) so the
  // feedback maps to the design the user actually saw. `answers`/`round` defaults match
  // the generate route's (`body.answers ?? []`, `body.round ?? 0`).
  const promptHash = hashPrompt({
    description: body.description,
    answers: body.answers ?? [],
    round: body.round ?? 0,
    model: ctx.config.LLM_MODEL,
    region: ctx.config.DEFAULT_REGION,
  });

  // Snapshot the rated output while it's still cached so review survives cache TTL.
  let recommendedTier = "unknown";
  let bodyJson: string | null = null;
  const cached = ctx.stores.responseCache.get(promptHash, ctx.config.RESPONSE_CACHE_TTL_MS);
  if (cached) {
    bodyJson = cached.body;
    try {
      recommendedTier =
        (JSON.parse(cached.body) as { recommendedTier?: string }).recommendedTier ?? "unknown";
    } catch {
      /* malformed cached body — keep "unknown" but still snapshot the raw text */
    }
  }

  const entry = ctx.stores.feedback.upsert({
    promptHash,
    description: body.description,
    answers: body.answers ?? [],
    round: body.round ?? 0,
    recommendedTier,
    body: bodyJson,
    rating: body.rating,
    ip,
    comment: null,
  });

  return reply.code(200).send({ rating: entry.rating });
}
