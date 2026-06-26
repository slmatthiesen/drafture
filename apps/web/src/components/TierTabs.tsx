/**
 * U10 / R3 — budget / balanced / resilient tabs. Switching a tab re-renders the
 * selected tier's diagram + setup + cost table + security + burst + tradeoffs.
 *
 * KTD9: the budget tab/section is framed as the "minimum safe cost" — all three
 * tiers carry the full R7 security floor, so budget is never security-relaxed.
 */

import { useState } from "react";
import type { Tier, TierName } from "../lib/types.js";
import { graphToMermaid } from "../lib/mermaid.js";
import { DiagramView } from "./DiagramView.js";
import { SetupSteps } from "./SetupSteps.js";
import { CostTable } from "./CostTable.js";
import { CostSummary } from "./CostSummary.js";
import { SecurityPanel } from "./SecurityPanel.js";
import { ReferenceConfig } from "./ReferenceConfig.js";

const TAB_LABELS: Record<TierName, string> = {
  budget: "Budget",
  balanced: "Balanced",
  resilient: "Resilient",
};

const TAB_SUBLABELS: Partial<Record<TierName, string>> = {
  budget: "minimum safe cost",
};

export function TierTabs({
  tiers,
  assumptions,
  recommendedTier,
}: {
  tiers: Tier[];
  assumptions: string[];
  recommendedTier?: TierName;
}): JSX.Element {
  // Lead with the architect's recommendation: preselect it when present.
  const initial =
    (recommendedTier && tiers.some((t) => t.name === recommendedTier) && recommendedTier) ||
    tiers[0]?.name ||
    "budget";
  const [selected, setSelected] = useState<TierName>(initial);
  const tier = tiers.find((t) => t.name === selected) ?? tiers[0];

  if (!tier) return <p>No tiers to display.</p>;

  return (
    <div className="tiers">
      <div className="tiers__tablist" role="tablist" aria-label="Robustness tiers">
        {tiers.map((t) => (
          <button
            key={t.name}
            role="tab"
            aria-selected={t.name === selected}
            className={`tiers__tab ${t.name === selected ? "tiers__tab--active" : ""}`}
            onClick={() => setSelected(t.name)}
          >
            <span className="tiers__tab-name">{TAB_LABELS[t.name]}</span>
            {t.name === recommendedTier ? (
              <span className="tiers__tab-badge">Recommended</span>
            ) : (
              TAB_SUBLABELS[t.name] && (
                <span className="tiers__tab-sub">{TAB_SUBLABELS[t.name]}</span>
              )
            )}
          </button>
        ))}
      </div>

      <section className="tier" role="tabpanel" aria-label={`${TAB_LABELS[tier.name]} tier`}>
        <header className="tier__header">
          <h2>
            {TAB_LABELS[tier.name]}
            {tier.name === "budget" && (
              <span className="tier__tag"> — minimum safe cost</span>
            )}
          </h2>
          <p className="tier__summary">{tier.summary}</p>
          <CostSummary drivers={tier.costDrivers} />
          {tier.name === "budget" && (
            <p className="tier__safe-note">
              Lowest cost that still keeps the full security floor — never a security-relaxed option.
            </p>
          )}
        </header>

        <DiagramView chart={graphToMermaid(tier.nodes, tier.edges)} />

        <SetupSteps steps={tier.setupSteps} />

        <CostTable drivers={tier.costDrivers} assumptions={assumptions} />

        <SecurityPanel notes={tier.securityNotes} />

        <section className="card burst" aria-label="Burst handling">
          <h3>Burst handling</h3>
          <ul>
            {tier.burstHandling.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </section>

        <section className="card tradeoffs" aria-label="Trade-offs">
          <h3>Trade-offs vs other tiers</h3>
          <ul>
            {tier.tradeoffs.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>

        <ReferenceConfig tier={tier} />
      </section>
    </div>
  );
}
