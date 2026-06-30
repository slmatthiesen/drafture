/**
 * Backend-neutral clock + day-bucketing, shared by both the SQLite and DynamoDB
 * store implementations. Extracted from sqlite.ts so a DynamoDB store can depend on
 * the injectable clock without pulling in better-sqlite3.
 */

/**
 * Injectable clock so day-boundary and TTL behavior is testable without waiting
 * on real time. The UTC day key is always derived from `now()` (single knob).
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** UTC calendar day bucket (YYYY-MM-DD) used for spend + per-IP daily counts. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
