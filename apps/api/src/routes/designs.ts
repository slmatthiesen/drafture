/**
 * Generation-gallery routes — the public, server-stored user-generated designs.
 *
 *   GET  /api/designs/:id      → one approved design's full body for a deep-link render
 *                               ($0, no LLM). 404 unless status === "approved", so
 *                               pending/hidden rows are never publicly reachable by id.
 *   POST /api/designs/:id/vote → cast an up/down vote, deduped per voter; net
 *                               downvotes at/below the threshold auto-hide an
 *                               approved design back into the review queue.
 *
 * (GET /api/designs — the browsable gallery list — arrives with the Phase 2 gallery
 * UI.) The vote route reuses the existing friction chain (access gate → Turnstile →
 * per-IP rate limit) and keys one vote per voter off the same client-IP strategy the
 * guards use, so a refresh can't stuff the ballot.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppContext } from "../app/context.js";
import { clientIp } from "../guards/clientIp.js";

interface VoteBody {
  value: 1 | -1;
}

const voteBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    // Only ±1 — anything else is invalid input (400).
    value: { type: "integer", enum: [1, -1] },
  },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

const ROUTE = "/api/designs";

export async function registerDesignsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    `${ROUTE}/:id`,
    { schema: { params: idParamsSchema }, preHandler: [ctx.guards.accessGate] },
    (req, reply) => handleGet(ctx, req, reply),
  );

  app.post(
    `${ROUTE}/:id/vote`,
    {
      schema: { params: idParamsSchema, body: voteBodySchema },
      preHandler: [ctx.guards.accessGate, ctx.guards.turnstile, ctx.guards.rateLimit.preHandler],
    },
    (req, reply) => handleVote(ctx, req, reply),
  );
}

function handleGet(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): unknown {
  const { id } = req.params as { id: string };
  const record = ctx.stores.generations.getById(id);
  // Pending/hidden designs are not public — same 404 as a missing id so the gate
  // can't be probed to learn which ids exist in the review queue.
  if (!record || record.status !== "approved") {
    return reply.code(404).send({ error: "not_found", message: "Unknown design." });
  }
  // `body` is the verbatim /api/generate JSON (tiers, assumptions, securityFloor,
  // recommendedTier, recommendationRationale, keyDecisions). Surface it as one flat
  // `design` object plus the prompt so the same result renderer consumes it.
  return reply.code(200).send({
    id: record.id,
    prompt: record.description,
    design: JSON.parse(record.body),
  });
}

function handleVote(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): unknown {
  const { id } = req.params as { id: string };
  const { value } = req.body as VoteBody;
  const voter = clientIp(req);

  const result = ctx.stores.generations.vote(id, voter, value, ctx.config.GENERATION_HIDE_NET_VOTES);
  if (!result) return reply.code(404).send({ error: "not_found", message: "Unknown generation." });
  return reply.code(200).send(result);
}
