/**
 * Faithful redaction of credential shapes from a free-text prompt BEFORE it reaches
 * the model or storage (Option A). Strips AWS key ids, PEM private-key blocks, and
 * secret/password/token assignments, replacing each with a [REDACTED] placeholder —
 * but leaves the surrounding architectural intent untouched.
 *
 * This is why the scrubbed text can be stored as the CANONICAL prompt without keeping
 * a raw copy: redacting a pasted key from "build a chat app" does not change the
 * architecture the model produces, so the stored prompt still re-runs to something
 * equivalent. It also means the model never sees the secret, so it can't echo one
 * back in assumptions/summary — the stored body is clean by construction.
 *
 * PII (names, companies) is deliberately NOT matched here: free text has no reliable
 * PII shape, and a regex broad enough to catch names would mangle intent. The human
 * approval gate is the backstop for those cases; secret scrubbing is the part that is
 * both deterministic and safe to automate.
 */
export interface ScrubResult {
  text: string;
  wasRedacted: boolean;
}

/** PEM private-key block (RSA/EC/OpenSSH/PKCS8/Generic), including the boundaries. */
const PEM_BLOCK = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g;

/** AWS access-key id formats (AKIA = long-term, ASIA = temporary/STS). */
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

/**
 * A credential NAME followed by a separator and a value of plausible length. The
 * leading `[A-Za-z0-9]` + `{7,}` body avoids matching trivial words while catching
 * real secret values ("password=hunter2secret", "api_key: sk-live-Ab12...", ...).
 */
const SECRET_ASSIGNMENT =
  /\b(?:secret|secrets|password|passwd|token|api[_-]?key|access[_-]?token|auth[_-]?token|access[_-]?key[_-]?secret|secret[_-]?access[_-]?key|client[_-]?secret|private[_-]?key|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9][A-Za-z0-9/_+=.\-~]{7,}["']?/gi;

const PLACEHOLDER = "[REDACTED]";
const RULES = [PEM_BLOCK, AWS_ACCESS_KEY_ID, SECRET_ASSIGNMENT];

/**
 * Redact credential shapes from `text`, preserving everything else. Pure and
 * idempotent: scrubbing an already-scrubbed text is a no-op (the placeholder is not a
 * credential shape).
 */
export function scrubPrompt(text: string): ScrubResult {
  let out = text;
  let wasRedacted = false;
  for (const rule of RULES) {
    if (rule.test(out)) {
      wasRedacted = true;
      rule.lastIndex = 0; // .test() with the /g flag advances lastIndex; reset before replace.
      out = out.replaceAll(rule, PLACEHOLDER);
    }
  }
  return { text: out, wasRedacted };
}

/** Scrub a list of strings (e.g. intake answers), reporting whether any redacted. */
export function scrubAll(texts: string[]): { texts: string[]; wasRedacted: boolean } {
  let wasRedacted = false;
  const out = texts.map((t) => {
    const r = scrubPrompt(t);
    if (r.wasRedacted) wasRedacted = true;
    return r.text;
  });
  return { texts: out, wasRedacted };
}

/**
 * Defense-in-depth: scrub every string in an arbitrary object tree (the generation
 * OUTPUT) — redacts any credential shape the model echoed into free-text fields
 * (assumptions, summaries, rationale) even though the input was already scrubbed before
 * the model saw it. Returns a NEW deep-cloned tree (input is not mutated) plus whether
 * anything changed. Non-string leaves (enums, ids, numbers) pass through unchanged, and
 * scrubPrompt is a no-op on strings with no credential shape, so legitimate architecture
 * values are never altered.
 */
export function scrubObject<T>(value: T): { value: T; wasRedacted: boolean } {
  let wasRedacted = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = scrubPrompt(v);
      if (r.wasRedacted) wasRedacted = true;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, wasRedacted };
}
