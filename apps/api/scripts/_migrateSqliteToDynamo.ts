/**
 * One-shot $0 migration of the durable local data from SQLite → DynamoDB (plan §6:
 * "migrate, don't re-seed"). Carries curated runs, generations, design embeddings, and
 * all per-voter votes — the gallery + RAG corpus + community signal — preserving ids,
 * status, terraform cache, and vote counts exactly. Caches (response/pricing/spend/
 * research memory) are intentionally skipped: they rebuild.
 *
 * Reads RAW from the SQLite tables and writes the exact DynamoDB item shapes the
 * DynamoStores expect (the store interfaces alone can't express "preserve this id +
 * status + these per-voter votes"). Idempotent — PutItem overwrites, so a re-run is safe.
 *
 * Usage (target via DYNAMO_* env, e.g. against the emulator or real AWS):
 *   DYNAMO_ENDPOINT=http://127.0.0.1:8000 DYNAMO_TABLE_PREFIX=drafture_ \
 *     tsx scripts/_migrateSqliteToDynamo.ts
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";

import { getConfig } from "../src/config.js";
import { getDb } from "../src/store/sqlite.js";
import { makeDynamoDeps, dynamoConfigFromAppConfig, type DynamoDeps } from "../src/store/dynamo/client.js";
import { createTables } from "../src/store/dynamo/schema.js";

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

async function put(deps: DynamoDeps, logical: Parameters<DynamoDeps["table"]>[0], item: Record<string, unknown>): Promise<void> {
  await deps.doc.send(new PutCommand({ TableName: deps.table(logical), Item: item }));
}

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb(config.DB_PATH);
  const deps = makeDynamoDeps(dynamoConfigFromAppConfig(config));

  console.log(`Source SQLite: ${config.DB_PATH}`);
  console.log(`Target DynamoDB: prefix="${config.DYNAMO_TABLE_PREFIX}" endpoint=${config.DYNAMO_ENDPOINT ?? "(AWS default)"}`);
  console.log("Ensuring target tables exist…");
  await createTables(deps);

  // --- curated runs + votes -------------------------------------------------
  const curatedRuns = db
    .prepare("SELECT id, title, prompt, body, upvotes, downvotes, hidden, created_at FROM curated_runs")
    .all() as Array<{ id: string; title: string; prompt: string; body: string; upvotes: number; downvotes: number; hidden: number; created_at: number }>;
  for (const r of curatedRuns) {
    await put(deps, "curated", {
      id: r.id,
      sk: "meta",
      title: r.title,
      prompt: r.prompt,
      body: r.body,
      upvotes: r.upvotes,
      downvotes: r.downvotes,
      hidden: r.hidden === 1,
      createdAt: r.created_at,
    });
  }
  const curatedVotes = db
    .prepare("SELECT run_id, voter, value, created_at FROM curated_votes")
    .all() as Array<{ run_id: string; voter: string; value: number; created_at: number }>;
  for (const v of curatedVotes) {
    await put(deps, "curated", { id: v.run_id, sk: `vote#${v.voter}`, value: v.value, createdAt: v.created_at });
  }
  console.log(`  curated: ${curatedRuns.length} runs, ${curatedVotes.length} votes`);

  // --- generations + votes --------------------------------------------------
  // Migrate ALL generations (any status), not just approved: this preserves the operator
  // review queue (pending) and crowd-hidden rows too — strictly more faithful than a
  // re-seed, at trivial cost. Votes are carried as child items so counts are exact.
  const gens = db
    .prepare("SELECT * FROM generations")
    .all() as Array<Record<string, unknown>>;
  for (const g of gens) {
    await put(deps, "generations", {
      id: g.id,
      sk: "meta",
      promptHash: g.prompt_hash,
      description: g.description,
      answers: safeParse(g.answers_json as string | null, [] as string[]),
      model: g.model,
      region: g.region,
      recommendedTier: g.recommended_tier,
      tags: safeParse(g.tags_json as string | null, [] as string[]),
      body: g.body_json,
      terraformJson: (g.terraform_json as string | null) ?? null,
      status: g.status,
      optOut: g.opt_out === 1,
      genCount: g.gen_count,
      clientIp: g.client_ip,
      upvotes: g.upvotes,
      downvotes: g.downvotes,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
    });
  }
  const genVotes = db
    .prepare("SELECT generation_id, voter, value, created_at FROM generation_votes")
    .all() as Array<{ generation_id: string; voter: string; value: number; created_at: number }>;
  for (const v of genVotes) {
    await put(deps, "generations", { id: v.generation_id, sk: `vote#${v.voter}`, value: v.value, createdAt: v.created_at });
  }
  console.log(`  generations: ${gens.length} rows, ${genVotes.length} votes`);

  // --- design embeddings ----------------------------------------------------
  const embeddings = db
    .prepare("SELECT id, source, prompt_hash, text, vector, dim, model, created_at FROM design_embeddings")
    .all() as Array<{ id: string; source: string; prompt_hash: string; text: string; vector: Buffer; dim: number; model: string; created_at: number }>;
  for (const e of embeddings) {
    await put(deps, "designVectors", {
      id: e.id,
      source: e.source,
      promptHash: e.prompt_hash,
      text: e.text,
      vector: e.vector, // little-endian Float32 blob — stored as Binary, read by blobToVector
      dim: e.dim,
      model: e.model,
      createdAt: e.created_at,
    });
  }
  console.log(`  designVectors: ${embeddings.length} embeddings`);

  console.log("Migration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
