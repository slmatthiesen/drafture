/**
 * SQLite-backed store for the admin-curated example gallery.
 *
 * A curated run is a saved `/api/generate` response (the full design) plus a short
 * title, surfaced on the landing page so visitors can open real examples instantly
 * for $0 — no LLM call, immune to the browser-local history being cleared.
 *
 * Votes are one-per-voter (keyed by the same client-IP strategy the guards use):
 * a second vote from the same voter changes their prior vote rather than stacking,
 * and the per-run counters are recomputed from the votes table inside the same
 * transaction so they can never drift.
 */
import type { CuratedRun, CuratedRunSummary, CuratedStore, CuratedVoteResult } from "./types.js";
import type { Db, Clock } from "./sqlite.js";
import { systemClock } from "./sqlite.js";

interface RunRow {
  id: string;
  title: string;
  prompt: string;
  body: string;
  upvotes: number;
  downvotes: number;
  created_at: number;
}

export class SqliteCuratedStore implements CuratedStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  list(): CuratedRunSummary[] {
    // Body is read (not returned) only to derive the one-line tech blurb; 4 rows, so
    // parsing per call is negligible and keeps the gallery card self-describing.
    // hidden=0 only: a suppressed seed design leaves the gallery (and, via get()
    // returning undefined, the deep-link + RAG read paths too).
    const rows = this.db
      .prepare(
        `SELECT id, title, prompt, body, upvotes, downvotes, created_at
         FROM curated_runs
         WHERE hidden = 0
         ORDER BY (upvotes - downvotes) DESC, created_at DESC`,
      )
      .all() as RunRow[];
    return rows.map((r) => ({ ...toSummary(r), tech: deriveTech(r.body) }));
  }

  get(id: string): CuratedRun | undefined {
    // A hidden run is invisible everywhere it could be served — the deep-link route
    // and `retrieve.loadDesign` both go through get(), mirroring how a non-approved
    // generation is filtered out of retrieval.
    const row = this.db.prepare(`SELECT * FROM curated_runs WHERE id = ? AND hidden = 0`).get(id) as
      | RunRow
      | undefined;
    if (!row) return undefined;
    return { ...toSummary(row), tech: deriveTech(row.body), body: row.body };
  }

  /** Suppress (or restore) a curated run. Returns false for an unknown id. */
  setHidden(id: string, hidden: boolean): boolean {
    const res = this.db
      .prepare(`UPDATE curated_runs SET hidden = ? WHERE id = ?`)
      .run(hidden ? 1 : 0, id);
    return res.changes > 0;
  }

  upsert(run: { id: string; title: string; prompt: string; body: string }): void {
    // Replace content but KEEP the existing vote counters on conflict — re-seeding a
    // run shouldn't reset the community signal it has accumulated.
    this.db
      .prepare(
        `INSERT INTO curated_runs (id, title, prompt, body, upvotes, downvotes, created_at)
         VALUES (@id, @title, @prompt, @body, 0, 0, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           prompt = excluded.prompt,
           body = excluded.body`,
      )
      .run({ ...run, createdAt: this.clock.now() });
  }

  vote(id: string, voter: string, value: 1 | -1): CuratedVoteResult | undefined {
    const tx = this.db.transaction((): CuratedVoteResult | undefined => {
      const exists = this.db.prepare(`SELECT 1 FROM curated_runs WHERE id = ?`).get(id);
      if (!exists) return undefined;

      this.db
        .prepare(
          `INSERT INTO curated_votes (run_id, voter, value, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id, voter) DO UPDATE SET value = excluded.value`,
        )
        .run(id, voter, value, this.clock.now());

      // Recompute counters from the votes table so they always match the rows.
      const counts = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS up,
             COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS down
           FROM curated_votes WHERE run_id = ?`,
        )
        .get(id) as { up: number; down: number };

      this.db
        .prepare(`UPDATE curated_runs SET upvotes = ?, downvotes = ? WHERE id = ?`)
        .run(counts.up, counts.down, id);

      return { upvotes: counts.up, downvotes: counts.down };
    });
    return tx();
  }
}

function toSummary(row: Omit<RunRow, "body">): Omit<CuratedRunSummary, "tech"> {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    createdAt: row.created_at,
  };
}

/**
 * One-line tech blurb for the gallery card: the distinct AWS services of the
 * recommended tier (its most representative shape), top few, " · "-joined. Defensive
 * — a malformed/legacy body yields an empty string rather than throwing.
 */
const TECH_SERVICE_LIMIT = 4;

function deriveTech(body: string): string {
  try {
    const design = JSON.parse(body) as {
      recommendedTier?: string;
      tiers?: { name: string; nodes?: { awsService?: string }[] }[];
    };
    const tiers = design.tiers ?? [];
    const tier = tiers.find((t) => t.name === design.recommendedTier) ?? tiers[0];
    const services = (tier?.nodes ?? [])
      .map((n) => n.awsService?.trim())
      .filter((s): s is string => !!s);
    return [...new Set(services)].slice(0, TECH_SERVICE_LIMIT).join(" · ");
  } catch {
    return "";
  }
}
