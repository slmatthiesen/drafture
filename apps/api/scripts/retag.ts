/**
 * Recompute deterministic facet tags for every stored design — generations AND curated
 * runs — from the current SERVICE_CATEGORIES map / tagDesign logic. Re-run after
 * editing the map so stored tags stay in sync (the gallery filters on stored tags).
 * No model call, no spend.
 *
 * Run:  pnpm --filter @stackdraft/api exec node --env-file=../../.env --import tsx scripts/retag.ts
 */
import { getConfig } from "../src/config.js";
import { getDb } from "../src/store/sqlite.js";
import { tagDesign } from "../src/pipeline/tags.js";
import type { ArchitectureResult } from "../src/schema/architecture.js";

function main(): void {
  const config = getConfig();
  const db = getDb(config.DB_PATH);

  const retagGen = db.prepare(`UPDATE generations SET tags_json = ? WHERE id = ?`);
  const gens = db.prepare(`SELECT id, body_json FROM generations`).all() as { id: string; body_json: string }[];
  let genCount = 0;
  for (const g of gens) {
    retagGen.run(JSON.stringify(tagsFromBody(g.body_json)), g.id);
    genCount++;
  }

  // Same taxonomy so the gallery facets curated + user-generated designs uniformly.
  const retagCur = db.prepare(`UPDATE curated_runs SET tags_json = ? WHERE id = ?`);
  const curated = db.prepare(`SELECT id, body FROM curated_runs`).all() as { id: string; body: string }[];
  let curCount = 0;
  for (const c of curated) {
    retagCur.run(JSON.stringify(tagsFromBody(c.body)), c.id);
    curCount++;
  }

  console.log(`Retagged ${genCount} generation(s) and ${curCount} curated run(s).`);
  db.close();
}

function tagsFromBody(bodyJson: string): string[] {
  try {
    return tagDesign(JSON.parse(bodyJson) as ArchitectureResult);
  } catch {
    return [];
  }
}

void main();
