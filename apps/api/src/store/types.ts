/**
 * Storage contracts (KTD5). V1 backs all four with one SQLite file; a Redis
 * implementation can drop in behind the same interfaces without changing
 * callers.
 */

/** A curated/researched best-practice fact (KB doc shape, U4/U6). */
export interface MemoryDoc {
  id: string;
  topic: string;
  fact: string;
  rationale: string;
  source: string;
  /** false = research-on-miss quarantine; surfaced as "unverified" until operator review (KTD4). */
  verified: boolean;
  provenance: "seed" | "research";
  createdAt: number;
  updatedAt: number;
}

export interface MemoryStore {
  upsert(doc: Omit<MemoryDoc, "createdAt" | "updatedAt"> & Partial<Pick<MemoryDoc, "createdAt" | "updatedAt">>): MemoryDoc;
  get(topic: string): MemoryDoc | undefined;
  getById(id: string): MemoryDoc | undefined;
  /** Topics with a verified or quarantined hit, used by grounding to detect misses. */
  search(topics: string[]): MemoryDoc[];
  listPending(): MemoryDoc[];
  setVerified(id: string, verified: boolean): boolean;
  delete(id: string): boolean;
}

export interface CachedResponse {
  promptHash: string;
  body: string;
  createdAt: number;
}

export interface ResponseCache {
  /** Returns undefined past TTL. */
  get(promptHash: string, ttlMs: number): CachedResponse | undefined;
  set(promptHash: string, body: string): void;
}

/** A normalized unit price keyed by (service, region) (KTD6). */
export interface PriceRecord {
  service: string;
  region: string;
  /** e.g. 'per-1k-requests', 'gb-month', 'hour', 'gb-transfer'. */
  unit: string;
  usd: number;
  month: string; // YYYY-MM snapshot this price belongs to
  note: string;
}

export interface PricingStore {
  get(service: string, region: string): PriceRecord[];
  /** Atomically replace one month's rows for a region (refresh job, U7). */
  replaceMonth(region: string, month: string, records: PriceRecord[]): void;
  /** Seed offline-fallback facts without clobbering a fresher month. */
  seed(records: PriceRecord[]): void;
}

/** Outcome of a reserve-on-entry spend check (KTD7). */
export interface SpendReservation {
  ok: boolean;
  /** Opaque id used to reconcile the provisional debit to actual usage. */
  reservationId: string;
  spentTodayUsd: number;
  ceilingUsd: number;
}

export interface SpendLedger {
  /**
   * Transactionally reserve a provisional debit at guard time. Concurrent callers
   * cannot each pass the ceiling check (no overshoot) — SQLite serializes writers.
   */
  reserve(provisionalUsd: number, ceilingUsd: number): SpendReservation;
  /** Reconcile a reservation to the actual cost once generation completes. */
  reconcile(reservationId: string, actualUsd: number): void;
  /** Release a reservation that never produced a charge (e.g. error). */
  release(reservationId: string): void;
  spentTodayUsd(): number;

  /** Per-IP daily generation counter for the per-IP cap (U8). */
  incrementIpCount(ip: string): number;
  ipCountToday(ip: string): number;
}

/**
 * An admin-curated example design surfaced in the public gallery. The `body` is the
 * verbatim `/api/generate` response JSON, so the frontend renders a curated run
 * through the same path as a freshly generated one — instantly and for $0.
 */
export interface CuratedRunSummary {
  id: string;
  title: string;
  prompt: string;
  /** One-line tech blurb (top services of the recommended tier) for the gallery card. */
  tech: string;
  upvotes: number;
  downvotes: number;
  createdAt: number;
}

export interface CuratedRun extends CuratedRunSummary {
  /** JSON-encoded GenerateResponse (tiers + costs + securityFloor + recommendation). */
  body: string;
}

export interface CuratedVoteResult {
  upvotes: number;
  downvotes: number;
}

export interface CuratedStore {
  /** Gallery list (no body), best-scored first. */
  list(): CuratedRunSummary[];
  /** Full run incl. body for rendering; undefined if unknown id. */
  get(id: string): CuratedRun | undefined;
  /** Admin insert/replace (seed script). Preserves existing votes on replace. */
  upsert(run: { id: string; title: string; prompt: string; body: string }): void;
  /**
   * Cast or change one voter's up/down vote, recomputing counters. Returns the new
   * counts, or undefined if the run does not exist.
   */
  vote(id: string, voter: string, value: 1 | -1): CuratedVoteResult | undefined;
}

/**
 * One visitor's thumbs-up/down verdict on a generated design. `promptHash` ties it to
 * the exact prompt→output pair (it is the /api/generate response-cache key), and the
 * rated `body` is snapshotted so the operator review script is self-contained and
 * survives the 24h response-cache TTL.
 */
export interface FeedbackEntry {
  id: string;
  /** SHA-256 of {description, answers, round, model, region} — the generate cache key. */
  promptHash: string;
  description: string;
  /** Intake answers present at generation time (may be empty). */
  answers: string[];
  round: number;
  /** The recommendedTier the user rated; "unknown" if the body had expired. */
  recommendedTier: string;
  /** Verbatim GenerateResponse JSON at feedback time (null if the cache entry expired). */
  body: string | null;
  /** 1 = up, -1 = down. */
  rating: 1 | -1;
  /** Client IP — the only identity for an anonymous public tool. */
  ip: string;
  /** Nullable; schema-ready for a future free-text reason (not surfaced in v1). */
  comment: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackStore {
  /**
   * Insert or update one IP's verdict on one design. The table's UNIQUE(ip, prompt_hash)
   * means a second vote from the same IP on the same design CHANGES the prior rating
   * (never stacks), so re-clicking thumbs toggles/updates rather than ballot-stuffing.
   * Returns the canonical (post-conflict) entry.
   */
  upsert(entry: Omit<FeedbackEntry, "id" | "createdAt" | "updatedAt">): FeedbackEntry;
  /** Most-recently-updated entries filtered by rating (operator review script). */
  listByRating(rating: 1 | -1, limit: number): FeedbackEntry[];
}
