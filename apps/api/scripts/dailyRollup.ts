/**
 * Daily cost/outcome rollup (U15 — launch observability, offline, no spend).
 *
 * The lightweight pre-launch telemetry rollup: per-day generation volume, model
 * split, approval-status split, and dollars spent — read from what's already
 * persisted (the spend ledger + generations table). The per-REQUEST line
 * (obs/telemetry.ts) carries the live outcome/retrievalHit/completenessOk signal;
 * those go to logs (no telemetry table yet), so the daily outcome distribution
 * here is the persisted proxy: generation COUNT and approval STATUS, not the
 * clarify/refused/error breakdown. Real APM/dashboards are deferred until after
 * launch (docs/plans/2026-06-29-002 §4).
 *
 * Run:
 *   pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx scripts/dailyRollup.ts [days]
 */
import { getConfig } from "../src/config.js";
import { getDb } from "../src/store/sqlite.js";

interface GenDayRow {
  day: string;
  total: number;
  approved: number;
  pending: number;
  hidden: number;
}
interface SpendDayRow {
  day: string;
  usd: number;
  entries: number;
}
interface ModelRow {
  day: string;
  model: string;
  n: number;
}

function main(): void {
  const days = process.argv[2] && /^\d+$/.test(process.argv[2]) ? Number(process.argv[2]) : 14;
  const config = getConfig();
  const db = getDb(config.DB_PATH);

  // generations.created_at is epoch ms; bucket to a UTC day with SQLite date().
  const gen = db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS total,
              SUM(status = 'approved') AS approved,
              SUM(status = 'pending')  AS pending,
              SUM(status = 'hidden')   AS hidden
       FROM generations
       GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .all(days) as GenDayRow[];

  const spend = db
    .prepare(
      `SELECT day, COALESCE(SUM(amount_usd), 0) AS usd, COUNT(*) AS entries
       FROM spend_entries GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .all(days) as SpendDayRow[];

  const models = db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day, model, COUNT(*) AS n
       FROM generations GROUP BY day, model ORDER BY day DESC`,
    )
    .all() as ModelRow[];

  const spendByDay = new Map(spend.map((s) => [s.day, s]));
  const modelsByDay = new Map<string, string[]>();
  for (const m of models) {
    const arr = modelsByDay.get(m.day) ?? [];
    arr.push(`${m.model}×${m.n}`);
    modelsByDay.set(m.day, arr);
  }

  console.log(`Daily rollup — last ${days} day(s) (UTC), DB ${config.DB_PATH}\n`);
  console.log("day         designs  appr/pend/hid   spend$   models");
  console.log("──────────  ───────  ─────────────   ──────   ──────");
  for (const g of gen) {
    const s = spendByDay.get(g.day);
    const usd = s ? s.usd.toFixed(2).padStart(6) : "  0.00";
    const status = `${g.approved}/${g.pending}/${g.hidden}`.padEnd(13);
    const ms = (modelsByDay.get(g.day) ?? []).join(", ");
    console.log(`${g.day}  ${String(g.total).padStart(7)}  ${status}   ${usd}   ${ms}`);
  }

  // Spend-only days (config calls, research, etc. with no persisted generation row).
  const genDays = new Set(gen.map((g) => g.day));
  const spendOnly = spend.filter((s) => !genDays.has(s.day));
  if (spendOnly.length > 0) {
    console.log("\nspend with no generation row (config/research/clarify):");
    for (const s of spendOnly) console.log(`${s.day}  $${s.usd.toFixed(2)} (${s.entries} entries)`);
  }

  const totalUsd = spend.reduce((a, s) => a + s.usd, 0);
  const totalGens = gen.reduce((a, g) => a + g.total, 0);
  console.log(`\nwindow totals: ${totalGens} designs · $${totalUsd.toFixed(2)} spend`);
  db.close();
}

main();
