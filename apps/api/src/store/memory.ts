/**
 * SQLite-backed MemoryStore: curated/researched best-practice docs (KTD4).
 * Upsert is keyed by `id`; `created_at` is preserved across overwrites so a
 * re-upsert refreshes content + `updatedAt` without losing first-seen time.
 */
import type { MemoryStore, MemoryDoc } from "./types.js";
import type { Db, Clock } from "./sqlite.js";
import { systemClock } from "./sqlite.js";

interface MemoryRow {
  id: string;
  topic: string;
  fact: string;
  rationale: string;
  source: string;
  verified: number;
  provenance: string;
  created_at: number;
  updated_at: number;
}

type UpsertInput = Omit<MemoryDoc, "createdAt" | "updatedAt"> &
  Partial<Pick<MemoryDoc, "createdAt" | "updatedAt">>;

function toDoc(row: MemoryRow): MemoryDoc {
  return {
    id: row.id,
    topic: row.topic,
    fact: row.fact,
    rationale: row.rationale,
    source: row.source,
    verified: row.verified === 1,
    provenance: row.provenance as MemoryDoc["provenance"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteMemoryStore implements MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async upsert(doc: UpsertInput): Promise<MemoryDoc> {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO memory_docs
           (id, topic, fact, rationale, source, verified, provenance, created_at, updated_at)
         VALUES
           (@id, @topic, @fact, @rationale, @source, @verified, @provenance, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           topic = excluded.topic,
           fact = excluded.fact,
           rationale = excluded.rationale,
           source = excluded.source,
           verified = excluded.verified,
           provenance = excluded.provenance,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: doc.id,
        topic: doc.topic,
        fact: doc.fact,
        rationale: doc.rationale,
        source: doc.source,
        verified: doc.verified ? 1 : 0,
        provenance: doc.provenance,
        createdAt: doc.createdAt ?? now,
        updatedAt: doc.updatedAt ?? now,
      });
    // Return the stored row so the preserved created_at is reflected.
    const stored = await this.getById(doc.id);
    if (!stored) throw new Error(`memory upsert failed for id ${doc.id}`);
    return stored;
  }

  async get(topic: string): Promise<MemoryDoc | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_docs WHERE topic = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(topic) as MemoryRow | undefined;
    return row ? toDoc(row) : undefined;
  }

  async getById(id: string): Promise<MemoryDoc | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM memory_docs WHERE id = ?`)
      .get(id) as MemoryRow | undefined;
    return row ? toDoc(row) : undefined;
  }

  async search(topics: string[]): Promise<MemoryDoc[]> {
    if (topics.length === 0) return [];
    const placeholders = topics.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_docs WHERE topic IN (${placeholders}) ORDER BY updated_at DESC`,
      )
      .all(...topics) as MemoryRow[];
    return rows.map(toDoc);
  }

  async listPending(): Promise<MemoryDoc[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_docs WHERE verified = 0 ORDER BY created_at ASC`,
      )
      .all() as MemoryRow[];
    return rows.map(toDoc);
  }

  async setVerified(id: string, verified: boolean): Promise<boolean> {
    const info = this.db
      .prepare(`UPDATE memory_docs SET verified = ?, updated_at = ? WHERE id = ?`)
      .run(verified ? 1 : 0, this.clock.now(), id);
    return info.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    const info = this.db
      .prepare(`DELETE FROM memory_docs WHERE id = ?`)
      .run(id);
    return info.changes > 0;
  }
}
