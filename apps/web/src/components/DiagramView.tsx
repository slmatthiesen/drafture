/**
 * U11 — renders a Mermaid string to SVG client-side.
 *
 * jsdom can't run Mermaid's SVG renderer, so tests mock the `mermaid` module.
 */

import { useEffect, useState } from "react";
import mermaid from "mermaid";

// Mermaid global init is idempotent but we only want it once per page load.
let initialized = false;
// Monotonic id source — Mermaid requires a unique DOM id per render call.
let renderSeq = 0;

export function DiagramView({ chart }: { chart: string }): JSX.Element {
  const [svg, setSvg] = useState<string>("");
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => {
    // React 18 StrictMode runs effects twice in dev; `cancelled` discards the
    // stale first pass so we never paint an out-of-date diagram.
    let cancelled = false;

    if (!initialized) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      initialized = true;
    }

    setFailed(false);
    const id = `sd-diagram-${renderSeq++}`;
    mermaid
      .render(id, chart)
      .then((out) => {
        if (!cancelled) setSvg(out.svg);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setSvg("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (failed) {
    return (
      <div className="diagram diagram--fallback" role="img" aria-label="Architecture diagram (source)">
        <p className="diagram__note">Diagram preview unavailable — showing the source graph:</p>
        <pre>{chart}</pre>
      </div>
    );
  }

  return (
    <div
      className="diagram"
      aria-label="Architecture diagram"
      // svg is produced by Mermaid with securityLevel:'strict' (sanitized).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
