/**
 * Minimal, ZERO-DEPENDENCY HCL/Terraform highlighter.
 *
 * Why not Prism/highlight.js: the reference config is a single, occasionally-shown
 * code block. Pulling in a highlighter (Prism core + hcl ≈ 15 kB min, hljs far more)
 * to colour one panel isn't worth the bundle. This tokenizer covers the few HCL
 * constructs that matter for readability — comments, strings, numbers, booleans,
 * block keywords, `${…}` interpolation, and attribute keys — and emits classed
 * <span>s. Output is HTML-escaped FIRST, so it is safe to inject.
 *
 * Classes map to colours in index.css (`.hcl-*`). Not a full HCL parser; good enough
 * to make Terraform skimmable.
 */

const KEYWORDS = new Set([
  "resource",
  "provider",
  "variable",
  "output",
  "module",
  "data",
  "locals",
  "terraform",
  "true",
  "false",
  "null",
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function span(cls: string, text: string): string {
  return `<span class="hcl-${cls}">${text}</span>`;
}

/**
 * Returns highlighted HTML for a block of HCL. The whole input is escaped, then a
 * single ordered regex tokenizes it; the first matching group decides the class.
 */
export function highlightHcl(code: string): string {
  const escaped = escapeHtml(code);

  // Ordered alternation: comments, strings (with interpolation handled after),
  // numbers, and identifiers. `&quot;` is the escaped double-quote from escapeHtml.
  const token =
    /(#[^\n]*|\/\/[^\n]*)|(&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_-]*)/g;

  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(escaped)) !== null) {
    out += escaped.slice(last, m.index);
    last = token.lastIndex;

    if (m[1] !== undefined) {
      out += span("comment", m[1]);
    } else if (m[2] !== undefined) {
      // Highlight ${...} interpolations inside the string.
      out += span("string", m[2].replace(/\$\{[^}]*\}/g, (interp) => span("interp", interp)));
    } else if (m[3] !== undefined) {
      out += span("number", m[3]);
    } else {
      const word = m[4]!;
      // A word directly followed by `=` (optional ws) is an attribute key.
      const rest = escaped.slice(token.lastIndex);
      if (KEYWORDS.has(word)) {
        out += span("keyword", word);
      } else if (/^\s*=(?!=)/.test(rest)) {
        out += span("attr", word);
      } else {
        out += word;
      }
    }
  }
  out += escaped.slice(last);
  return out;
}
