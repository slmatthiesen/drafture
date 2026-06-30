/**
 * Tiny HCL emission primitives for the deterministic Terraform pipeline.
 *
 * Emitters return {@link HclBlock}s — a rendered HCL string plus the metadata the
 * assembler needs to order and de-duplicate them. There is NO HCL AST here on
 * purpose: the rest of the tree treats HCL as text (the wire-up detector in
 * `routes/config.ts` is regex/keyword-based, the golden files are byte snapshots),
 * so modelling an AST would be ceremony with no consumer. Blocks are authored as
 * template literals — the same shape a human writes — and this module only supplies
 * the cross-reference and value helpers that keep them coherent by construction.
 */

/** A rendered chunk of HCL (one or more top-level blocks) plus assembly metadata. */
export interface HclBlock {
  /** Section heading the assembler groups this block under (e.g. "S3 — assets"). */
  section: string;
  /** The rendered HCL text. Trailing whitespace is trimmed on assembly. */
  hcl: string;
  /**
   * Optional de-dupe key. Two blocks with the same key are emitted ONCE — used for
   * shared boilerplate several emitters reference (the `lambda.amazonaws.com`
   * assume-role policy document, a single shared KMS alias, …). First writer wins.
   */
  dedupeKey?: string;
}

/** Indent every line of `body` by `n` spaces (2 per level). Blank lines stay blank. */
export function indent(body: string, levels = 1): string {
  const pad = "  ".repeat(levels);
  return body
    .split("\n")
    .map((l) => (l.length === 0 ? l : pad + l))
    .join("\n");
}

/** A literal HCL string value, with `"` and `\` escaped. */
export function str(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serialize a JS value as the body of a `jsonencode(...)` IAM/KMS policy. Strings
 * are quoted; a {@link Raw} passes through unquoted so a policy can reference a
 * Terraform expression (`aws_s3_bucket.x.arn`). Produces 2-space-indented HCL-style
 * object/array syntax (HCL accepts `=`-style maps inside jsonencode).
 */
export class Raw {
  constructor(readonly expr: string) {}
}
export const raw = (expr: string): Raw => new Raw(expr);

export type Jsonish = string | number | boolean | Raw | Jsonish[] | { [k: string]: Jsonish };

function isPlainObject(v: Jsonish): v is { [k: string]: Jsonish } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Raw);
}

/** Render a value as HCL (used inside `jsonencode({ ... })`). */
export function hclValue(value: Jsonish, level = 0): string {
  if (value instanceof Raw) return value.expr;
  if (typeof value === "string") return str(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => indent(hclValue(v, level + 1), 1)).join(",\n");
    return `[\n${items}\n]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const entries = keys
      .map((k) => indent(`${quoteKeyIfNeeded(k)} = ${hclValue(value[k]!, level + 1)}`, 1))
      .join("\n");
    return `{\n${entries}\n}`;
  }
  return "null";
}

/** HCL bare keys must match an identifier; otherwise quote them. */
function quoteKeyIfNeeded(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) && !key.includes("-") ? key : str(key);
}

/** `jsonencode({ ... })` from a JS object — the canonical IAM/KMS policy emitter. */
export function jsonencode(value: Jsonish): string {
  return `jsonencode(${hclValue(value)})`;
}

/** AWS-IAM policy-document object (Version pinned), ready for {@link jsonencode}. */
export function policyDoc(statements: Jsonish[]): { [k: string]: Jsonish } {
  return { Version: "2012-10-17", Statement: statements };
}
