/** R7 — the safe-by-default security floor, stated ONCE and applied to every tier.
 *  Injected deterministically from the KB (the model never emits it). */

import { GlossaryText } from "./GlossaryText.js";

export function SecurityPanel({ floor }: { floor: string[] }): JSX.Element | null {
  if (floor.length === 0) return null;

  return (
    // Collapsed by default — it's the same non-negotiable floor on every design,
    // so it stays out of the way until you want to confirm it.
    <details className="card security">
      <summary className="security__summary" aria-label="Security floor">
        Security floor (applied to every tier)
        <span className="security__count"> · {floor.length} controls</span>
      </summary>
      <ul>
        {floor.map((item, i) => (
          <li key={i}>
            <GlossaryText>{item}</GlossaryText>
          </li>
        ))}
      </ul>
    </details>
  );
}
