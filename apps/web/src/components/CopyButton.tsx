/** Subtle copy-to-clipboard control. Shows a transient "Copied" confirmation. */

import { useState } from "react";

export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (no permission / insecure context) — stay silent */
    }
  };

  return (
    <button type="button" className="copy-btn" onClick={() => void copy()} aria-live="polite">
      {copied ? "Copied" : label}
    </button>
  );
}
