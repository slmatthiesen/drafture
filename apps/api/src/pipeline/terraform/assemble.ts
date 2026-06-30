/**
 * The assembler: typed graph → a single deterministic reference-Terraform file.
 *
 * It prepends the always-on baseline (providers, variables, KMS CMKs), emits each
 * node through its registered {@link ServiceEmitter}, derives the edge wiring
 * (IAM + security groups) in `glue.ts`, then de-duplicates shared blocks, groups by
 * section, and frames the file with the same REFERENCE-ONLY header and
 * `flagIfIncomplete` backstop the LLM path uses.
 *
 * The whole point (plan, step 3): because every wire-up consequence is a TEMPLATE
 * INVARIANT — the CMK key policy rides with the log group, the ACM validation with
 * the cert, the OAC grant with the origin bucket — `detectWireupGaps()` returns
 * ZERO on this output. The detector stops being a post-hoc warning and becomes the
 * contract these templates are tested against.
 *
 * Coverage is the hybrid lever: nodes whose service has no emitter are reported in
 * `coverage.unsupported`, so the caller can fill JUST those from the LLM
 * (`generateConfig`) instead of paying for the whole stack — shrinking the LLM
 * surface from the entire design to the long tail.
 */
import {
  REFERENCE_WARNING_HEADER,
  annotateWireupGaps,
  detectWireupGaps,
  flagIfIncomplete,
  type WireupGap,
} from "../../routes/config.js";
import type { Tier } from "../../schema/architecture.js";

import { buildCtx } from "./context.js";
import { emitBaseline } from "./baseline.js";
import { emitNetwork } from "./networking.js";
import { emitGlue } from "./glue.js";
import type { HclBlock } from "./hcl.js";
import { REGISTRY } from "./registry.js";

export interface TerraformCoverage {
  /** Total nodes in the tier. */
  total: number;
  /** Nodes emitted deterministically (had a registered emitter). */
  templated: number;
  /** Node ids whose service has no emitter (routed to LLM fallback / TODO). */
  unsupported: string[];
  /** templated / total, 0..1. */
  ratio: number;
}

export interface AssembledTerraform {
  code: string;
  coverage: TerraformCoverage;
  /** Residual wire-up gaps. The invariant: this is EMPTY for a fully-templated tier. */
  gaps: WireupGap[];
}

// Section print order — baseline first, then resources roughly in dependency order,
// observability and edge last. A section whose prefix isn't listed sorts to the end.
const SECTION_ORDER = [
  "Providers & variables",
  "KMS keys",
  "Networking",
  "IAM",
  "Security group",
  "EC2",
  "Self-managed PostgreSQL",
  "S3",
  "Secrets Manager",
  "Lambda",
  "EventBridge Scheduler",
  "SNS",
  "CloudWatch Logs",
  "CloudWatch Alarms",
  "CloudFront",
  "CloudTrail",
  "X-Ray",
  "Unsupported services",
] as const;

function sectionRank(section: string): number {
  const i = SECTION_ORDER.findIndex((p) => section.startsWith(p));
  return i === -1 ? SECTION_ORDER.length : i;
}

const BANNER = (tier: string): string =>
  `# =============================================================================\n` +
  `# REFERENCE-ONLY Terraform for the ${tier.toUpperCase()} tier — generated\n` +
  `# DETERMINISTICALLY from the design graph. Human review + hardening required.\n` +
  `# =============================================================================`;

const sectionHeading = (section: string): string =>
  `# =============================================================================\n` +
  `# ${section.toUpperCase()}\n` +
  `# =============================================================================`;

export function assembleTier(
  tier: Tier,
  opts: { region: string; compliance?: boolean },
): AssembledTerraform {
  const ctx = buildCtx(tier, opts.region, opts.compliance);

  const blocks: HclBlock[] = [...emitBaseline(ctx), ...emitNetwork(ctx)];
  const unsupported: string[] = [];
  let templated = 0;

  for (const node of tier.nodes) {
    const key = ctx.keyOf(node);
    const emitter = REGISTRY.get(key);
    if (!emitter) {
      unsupported.push(node.id);
      blocks.push({
        section: "Unsupported services",
        hcl: `# TODO: unsupported service — '${node.awsService}' (node '${node.id}', role: ${node.role}).\n# No deterministic emitter; fill from the LLM fallback or add an emitter to the registry.`,
      });
      continue;
    }
    templated += 1;
    blocks.push(...emitter(node, ctx));
  }

  blocks.push(...emitGlue(ctx));

  const body = renderBlocks(blocks);
  const tierName = typeof tier.name === "string" ? tier.name : "design";

  // The invariant. A fully-templated tier must have ZERO gaps; if any survive
  // (e.g. an unsupported node pulled in a half-wired resource) annotate them, the
  // same safety the LLM path applies — never ship a silent gap.
  const gaps = detectWireupGaps(body);
  const annotated = gaps.length > 0 ? annotateWireupGaps(body) : body;

  const code = `${REFERENCE_WARNING_HEADER}${BANNER(tierName)}\n\n${flagIfIncomplete(annotated)}`;

  return {
    code,
    coverage: {
      total: tier.nodes.length,
      templated,
      unsupported,
      ratio: tier.nodes.length === 0 ? 1 : templated / tier.nodes.length,
    },
    gaps,
  };
}

/** De-dupe by dedupeKey (first writer wins), group by section, join with headings. */
function renderBlocks(blocks: HclBlock[]): string {
  const seen = new Set<string>();
  const kept = blocks.filter((b) => {
    if (!b.dedupeKey) return true;
    if (seen.has(b.dedupeKey)) return false;
    seen.add(b.dedupeKey);
    return true;
  });

  // Stable sort by (sectionRank, section) so same-prefix sections cluster while
  // preserving each block's relative order within its section.
  const ordered = kept
    .map((b, i) => ({ b, i }))
    .sort((a, z) => {
      const r = sectionRank(a.b.section) - sectionRank(z.b.section);
      if (r !== 0) return r;
      if (a.b.section !== z.b.section) return a.b.section < z.b.section ? -1 : 1;
      return a.i - z.i;
    })
    .map((x) => x.b);

  const out: string[] = [];
  let current: string | null = null;
  for (const block of ordered) {
    if (block.section !== current) {
      out.push(sectionHeading(block.section));
      current = block.section;
    }
    out.push(block.hcl.trimEnd());
  }
  return out.join("\n\n") + "\n";
}
