/**
 * Curated-gallery routes — the public, server-stored example designs.
 *
 *   GET  /api/curated         → list summaries (no LLM, no spend; just a DB read)
 *   GET  /api/curated/:id      → one run's full design body for instant render ($0)
 *   POST /api/curated/:id/vote → cast an up/down vote, deduped per voter
 *
 * The GET routes are intentionally unguarded beyond the global access gate: they are
 * cheap reads that never touch the model or the spend ledger, and serving them even
 * after the daily budget is exhausted keeps the gallery usable (KTD8, same spirit as
 * a cache hit). The vote route reuses the existing friction chain (access gate →
 * Turnstile → per-IP rate limit) and keys one vote per voter off the same client-IP
 * strategy the guards use, so a refresh can't stuff the ballot.
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
    // Only ±1 — the store treats any other value as invalid input (400).
    value: { type: "integer", enum: [1, -1] },
  },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

export async function registerCuratedRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(ROUTE, { preHandler: [ctx.guards.accessGate] }, async (_req, reply) => {
    return reply.code(200).send({ runs: await ctx.stores.curated.list() });
  });

  app.get(
    `${ROUTE}/:id`,
    { schema: { params: idParamsSchema }, preHandler: [ctx.guards.accessGate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const run = await ctx.stores.curated.get(id);
      if (!run) return reply.code(404).send({ error: "not_found", message: "Unknown curated run." });
      // body is the verbatim /api/generate JSON — splice it up so the client gets one
      // flat design object plus the gallery metadata.
      return reply.code(200).send({
        id: run.id,
        title: run.title,
        prompt: run.prompt,
        upvotes: run.upvotes,
        downvotes: run.downvotes,
        design: JSON.parse(run.body),
      });
    },
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

const ROUTE = "/api/curated";

async function handleVote(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const { id } = req.params as { id: string };
  const { value } = req.body as VoteBody;
  const voter = clientIp(req);

  const result = await ctx.stores.curated.vote(id, voter, value);
  if (!result) return reply.code(404).send({ error: "not_found", message: "Unknown curated run." });
  return reply.code(200).send(result);
}
