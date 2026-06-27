/**
 * Deterministic, CLIENT-SIDE cost rollup (no backend call).
 *
 * Sums the low/high ends of each cost driver's monthly `estimateRange` into a
 * rough per-tier monthly band. Only ranges expressed as a monthly total
 * ("$LOW–$HIGH/mo") are summed; per-unit prices (e.g. "$0.023/GB-mo") and
 * anything unparseable are skipped, and `partial` flags that the band omits some
 * drivers. This is an order-of-magnitude estimate, never a quote.
 */

import type { CostDriver } from "./types.js";

export interface CostRollup {
  low: number;
  high: number;
  /** Number of drivers that contributed to the band. */
  counted: number;
  /** True when one or more drivers were skipped (unparseable / per-unit). */
  partial: boolean;
}

// "$12–$30/mo", "$0.20 - $0.90 /mo", "$1,200 to $2,000/month". Endpoints are two
// dollar amounts joined by a dash/"to"; a /mo(nth) suffix marks it as a monthly total.
const MONTHLY_RANGE =
  /\$\s*([\d,]+(?:\.\d+)?)\s*(?:[–—-]|to)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\/\s*mo(?:nth)?/i;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/** Parse a single driver's monthly range, or null when it isn't a monthly band. */
export function parseMonthlyRange(estimateRange: string): { low: number; high: number } | null {
  const m = MONTHLY_RANGE.exec(estimateRange);
  if (!m) return null;
  const low = toNumber(m[1]!);
  const high = toNumber(m[2]!);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

export function rollupCost(drivers: CostDriver[]): CostRollup {
  let low = 0;
  let high = 0;
  let counted = 0;
  for (const d of drivers) {
    const parsed = parseMonthlyRange(d.estimateRange);
    if (!parsed) continue;
    low += parsed.low;
    high += parsed.high;
    counted += 1;
  }
  return { low, high, counted, partial: counted < drivers.length };
}

/**
 * A driver whose cost is FIXED — always-on capacity (per-hour: NAT/ALB/ElastiCache/
 * EC2/Fargate) or storage / flat monthly charges (per-month). These recur even at
 * ZERO traffic, so they form the baseline. Per-request / per-GB units are variable
 * (traffic-driven) and excluded. Recognized by a per-hour or per-month unit label.
 */
function isFixedUnit(unit: string): boolean {
  return /hr|hour|month/i.test(unit);
}

/**
 * The monthly cost of just RUNNING these services with zero traffic — the
 * always-on + storage floor, i.e. the fixed-unit drivers at their low end. $0 for
 * a pure-serverless tier (Lambda + DynamoDB + S3-on-demand scale to zero at rest),
 * which is exactly why a serverless range can span $0 → hundreds: the spread is
 * traffic, not fixed cost.
 */
export function baselineCost(drivers: CostDriver[]): number {
  let baseline = 0;
  for (const d of drivers) {
    if (!isFixedUnit(d.unit)) continue;
    const parsed = parseMonthlyRange(d.estimateRange);
    if (parsed) baseline += parsed.low;
  }
  return baseline;
}

export function formatMoney(n: number): string {
  if (n >= 10) return String(Math.round(n));
  // Keep cents for small numbers, trimming trailing zeros (1.50 → "1.5", 2.00 → "2").
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** "~$15–$48/mo" for a rollup, or null when nothing parsed. */
export function formatCostBand(rollup: CostRollup): string | null {
  if (rollup.counted === 0) return null;
  return `~$${formatMoney(rollup.low)}–$${formatMoney(rollup.high)}/mo`;
}
