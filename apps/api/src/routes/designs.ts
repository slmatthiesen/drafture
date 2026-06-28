/**
 * Generation-gallery routes — the public, server-stored user-generated designs.
 *
 *   POST /api/designs/:id/vote → cast an up/down vote, deduped per voter; net
 *                               downvotes at/below the threshold auto-hide an
 *                               approved design back into the review queue.
 *
 * (GET /api/designs and /api/designs/:id — the browsable gallery list and the
 * deep-link render — arrive with the Phase 2 gallery UI.) The vote route reuses the
 * existing friction chain (access gate → Turnstile → per-IP rate limit) and keys one
 * vote per voter off the same client-IP strategy the guards use, so a refresh can't
 * stuff the ballot.
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
  app.post(
    `${ROUTE}/:id/vote`,
    {
      schema: { params: idParamsSchema, body: voteBodySchema },
      preHandler: [ctx.guards.accessGate, ctx.guards.turnstile, ctx.guards.rateLimit.preHandler],
    },
    (req, reply) => handleVote(ctx, req, reply),
  );
}

function handleVote(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): unknown {
  const { id } = req.params as { id: string };
  const { value } = req.body as VoteBody;
  const voter = clientIp(req);

  const result = ctx.stores.generations.vote(id, voter, value, ctx.config.GENERATION_HIDE_NET_VOTES);
  if (!result) return reply.code(404).send({ error: "not_found", message: "Unknown generation." });
  return reply.code(200).send(result);
}
