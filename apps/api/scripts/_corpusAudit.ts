/**
 * Corpus audit (offline, $0) — re-gate every SERVED design in the DB.
 *
 * Served = approved generations + all curated runs. For each, parse the stored
 * body and run the full property gate + the warn-only cost-honest checks
 * (budgetTierIsCostHonest / budgetIdleFloor). Prints a per-design line and a
 * summary of any below the bar, so we know exactly what is being served and which
 * IDs to hide.
 *
 *   node --import tsx scripts/_corpusAudit.ts
 */
import { getConfig } from "../src/config.js";
import { getDb, createStores } from "../src/store/sqlite.js";
import { runAllProperties, budgetTierIsCostHonest } from "../test/golden/properties.js";
import { budgetIdleFloor } from "../src/pipeline/costFloor.js";
import type { ArchitectureResult } from "../src/schema/architecture.js";

interface Audited {
  kind: "generation" | "curated";
  id: string;
  label: string;
  gatePass: number;
  gateTotal: number;
  fails: string[];
  costHonest: boolean;
  costReason: string;
}

function audit(kind: Audited["kind"], id: string, label: string, body: string): Audited {
  const design = JSON.parse(body) as ArchitectureResult;
  const gate = runAllProperties(design);
  const fails = gate.results.filter((r) => !r.ok);
  const ch = budgetTierIsCostHonest(design);
  return {
    kind,
    id,
    label,
    gatePass: gate.results.length - fails.length,
    gateTotal: gate.results.length,
    fails: fails.map((f) => `${f.name}: ${f.reason}`),
    costHonest: ch.ok,
    costReason: `$${budgetIdleFloor(design).usd}/mo · ${ch.reason}`,
  };
}

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb(config.DB_PATH);
  const stores = createStores(db);

  const audited: Audited[] = [];
  for (const s of await stores.generations.listApproved(10_000)) {
    const rec = await stores.generations.getById(s.id);
    if (rec) audited.push(audit("generation", rec.id, rec.description.slice(0, 50), rec.body));
  }
  for (const c of await stores.curated.list()) {
    const full = await stores.curated.get(c.id);
    if (full) audited.push(audit("curated", c.id, full.title, full.body));
  }

  console.log(`Auditing ${audited.length} served design(s) (approved generations + curated runs)\n`);
  for (const a of audited) {
    const gateMark = a.fails.length === 0 ? "13/13" : `${a.gatePass}/${a.gateTotal}`;
    const cost = a.costHonest ? "cost✓" : "cost✗";
    const flag = a.fails.length === 0 && a.costHonest ? "✓" : "✗";
    console.log(`${flag} [${a.kind === "generation" ? "gen" : "cur"}] ${a.id.padEnd(14)} gate ${gateMark.padEnd(6)} ${cost}  "${a.label}"`);
    for (const f of a.fails) console.log(`      GATE  ${f}`);
    if (!a.costHonest) console.log(`      COST  ${a.costReason}`);
  }

  const gateFail = audited.filter((a) => a.fails.length > 0);
  const costFail = audited.filter((a) => a.costHonest === false);
  console.log(`\n=== SUMMARY ===`);
  console.log(`served            : ${audited.length}`);
  console.log(`gate 13/13        : ${audited.length - gateFail.length}/${audited.length}`);
  console.log(`cost-honest budget: ${audited.length - costFail.length}/${audited.length} (warn-only)`);
  if (gateFail.length) {
    console.log(`\nBELOW THE HARD GATE (must hide):`);
    for (const a of gateFail) console.log(`  ${a.kind} ${a.id} — ${a.fails.map((f) => f.split(":")[0]).join(", ")}`);
  }
  db.close();
}

void main();
