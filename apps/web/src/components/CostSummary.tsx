/**
 * Per-tier rough monthly cost band — deterministic, client-side (no backend).
 * Sums the monthly cost-driver ranges; see `lib/cost.ts`.
 */

import type { CostDriver } from "../lib/types.js";
import { rollupCost, formatCostBand } from "../lib/cost.js";

export function CostSummary({ drivers }: { drivers: CostDriver[] }): JSX.Element | null {
  const rollup = rollupCost(drivers);
  const band = formatCostBand(rollup);
  if (!band) return null;

  return (
    <p className="cost-summary" aria-label="Estimated monthly cost">
      <span className="cost-summary__band">{band}</span>{" "}
      <span className="cost-summary__label">
        estimated{rollup.partial ? " · partial — some drivers not summed" : ""}
      </span>
    </p>
  );
}
