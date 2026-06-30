/**
 * Operator approval queue for persisted generations (offline — no model call, no spend).
 *
 * Every generation lands as `pending` and is NEVER public until approved here. With no
 * args it lists the pending queue (newest first); `approve <id>` publishes a design to
 * the gallery; `hide <id>` suppresses it back to review. Net crowd downvotes can also
 * auto-hide an approved design (see GenerationsStore.vote) — this is where you re-surface
 * or permanently suppress those. The shown description is the SCRUBBED text (secrets
 * already redacted) and the tags are deterministic, so the review is self-contained.
 *
 * Run:
 *   pnpm --filter @stackdraft/api exec node --env-file=../../.env --import tsx scripts/reviewGenerations.ts [N]
 *   pnpm --filter @stackdraft/api exec node --env-file=../../.env --import tsx scripts/reviewGenerations.ts approve <id>
 *   pnpm --filter @stackdraft/api exec node --env-file=../../.env --import tsx scripts/reviewGenerations.ts hide <id>
 */
import { getConfig } from "../src/config.js";
import { getDb, createStores } from "../src/store/sqlite.js";

async function main(): Promise<void> {
  const [cmd, target] = process.argv.slice(2);
  const config = getConfig();
  const db = getDb(config.DB_PATH);
  const stores = createStores(db);

  if (cmd === "approve" || cmd === "hide") {
    if (!target) {
      console.error(`usage: reviewGenerations.ts ${cmd} <id>`);
      process.exit(1);
    }
    // Try the generation queue first; fall back to a curated run (curated has no
    // pending/approved workflow, so approve = restore, hide = suppress its `hidden` flag).
    const asGen = await stores.generations.setStatus(target, cmd === "approve" ? "approved" : "hidden");
    if (asGen) {
      console.log(`${cmd}d  ${target} (generation)`);
    } else if (await stores.curated.setHidden(target, cmd === "hide")) {
      console.log(`${cmd}d  ${target} (curated)`);
    } else {
      console.log(`not found: ${target}`);
    }
    db.close();
    return;
  }

  const limit = cmd && /^\d+$/.test(cmd) ? Number(cmd) : 30;
  const pending = await stores.generations.listPending(limit);
  console.log(`${pending.length} pending generation(s) (newest first):\n`);
  for (const g of pending) {
    const preview = g.description.length > 120 ? `${g.description.slice(0, 120)}…` : g.description;
    console.log(`— [${g.recommendedTier}] ${g.id}   tags: ${g.tags.join(", ") || "—"}`);
    console.log(`    "${preview}"`);
    console.log(`    ${new Date(g.createdAt).toISOString()} · requested ×${g.genCount}`);
    console.log();
  }
  if (pending.length > 0) {
    console.log("Approve:  reviewGenerations.ts approve <id>");
    console.log("Hide:     reviewGenerations.ts hide <id>");
  }
  db.close();
}

void main();
