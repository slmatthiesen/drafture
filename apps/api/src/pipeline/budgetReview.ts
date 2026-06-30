/**
 * The internalized senior-architect budget review (docs/plans/2026-06-30-005, Step 6).
 *
 * The whole north star: WE are the checker. External reviewers kept hand-finding the
 * same two budget defects — paid enterprise security on a none-sensitivity tier, and
 * the always-on managed quartet quoted as "budget". This runs that review
 * DETERMINISTICALLY pre-handoff and emits the same verdict, so "another agent pushed
 * back" stops being how we find the over-build. It reuses the exact primitives the
 * hard gates use (so the review and the gate never disagree) and adds the honest
 * all-in baseline the reviewers ask for.
 */
import type { ArchitectureResult, Tier } from "../schema/architecture.js";
import { budgetIdleFloor, type IdleFloor } from "./costFloor.js";
import { isComplianceFlagged, paidSecurityMarkersOnTier } from "./securityTiers.js";

export type Severity = "blocker" | "advisory" | "ok";

export interface BudgetFinding {
  id: "paid-security-on-budget" | "always-on-quartet" | "all-in-baseline";
  severity: Severity;
  title: string;
  detail: string;
}

export interface BudgetReview {
  /** True when no blocker finding remains — the budget is cheapest-correct. */
  ok: boolean;
  compliance: boolean;
  idleFloor: IdleFloor;
  findings: BudgetFinding[];
  /** A short handoff paragraph stating the honest all-in budget posture. */
  summary: string;
}

// Mirror the gate thresholds (test/golden/properties.ts budgetTierIsCostHonest) so the
// review and the hard gate render the same verdict.
const BUDGET_FLOOR_MAX_USD = 50;
const BUDGET_MAX_ALWAYS_ON_SERVICES = 2;

function budgetTier(result: ArchitectureResult): Tier | undefined {
  return result.tiers.find((t) => t.name === "budget");
}

export function reviewBudget(result: ArchitectureResult): BudgetReview {
  const compliance = isComplianceFlagged(result);
  const idleFloor = budgetIdleFloor(result);
  const budget = budgetTier(result);
  const findings: BudgetFinding[] = [];

  // (1) Paid security on a none-sensitivity budget — the reviewers' #1 finding.
  const markers = budget ? paidSecurityMarkersOnTier(budget) : [];
  if (markers.length > 0 && !compliance) {
    findings.push({
      id: "paid-security-on-budget",
      severity: "blocker",
      title: "Budget carries paid enterprise security the use case doesn't need",
      detail:
        `The budget tier deploys ${markers.join(", ")}. These are paid controls that ride the ` +
        `robustness ladder — move them to balanced+ (a one-line attach later). Budget should run ` +
        `the FREE structural floor: CloudFront + Shield Standard, SSE with AWS-managed keys, ` +
        `SSM Parameter Store, and a single-region CloudTrail.`,
    });
  } else if (markers.length > 0 && compliance) {
    findings.push({
      id: "paid-security-on-budget",
      severity: "ok",
      title: "Paid security in budget is correct-required (compliance)",
      detail: `Regulated/sensitive data detected — ${markers.join(", ")} belong in budget (cheapest *correct*).`,
    });
  }

  // (2) The always-on managed quartet quoted as budget — the reviewers' #2 finding.
  const quartetBloat =
    idleFloor.services.length > BUDGET_MAX_ALWAYS_ON_SERVICES || idleFloor.usd > BUDGET_FLOOR_MAX_USD;
  if (quartetBloat) {
    findings.push({
      id: "always-on-quartet",
      severity: "blocker",
      title: "Budget idle floor is an always-on managed stack, not cheapest-correct",
      detail:
        `Budget bills $${idleFloor.usd}/mo at ZERO traffic across ${idleFloor.services.length} always-on ` +
        `services [${idleFloor.services.join(", ")}]. The managed split (NAT + ALB + Fargate/ECS + RDS) ` +
        `belongs in balanced+; budget should be serverless-first or a single box.`,
    });
  }

  // (3) The honest all-in baseline the reviewers ask to see stated.
  const securityNote =
    markers.length > 0
      ? compliance
        ? ` plus the compliance-required paid floor (${markers.join(", ")})`
        : ` plus ${markers.join(", ")} that should move up the ladder`
      : " on the free structural security floor";
  findings.push({
    id: "all-in-baseline",
    severity: "ok",
    title: "Honest all-in budget baseline",
    detail:
      `Budget idle floor ≈ $${idleFloor.usd}/mo` +
      (idleFloor.services.length ? ` (${idleFloor.services.join(", ")})` : " (serverless, ~$0 idle)") +
      securityNote +
      `. Usage-scaled services (Lambda/DynamoDB/S3/API Gateway) add cost only with traffic.`,
  });

  const blockers = findings.filter((f) => f.severity === "blocker");
  return {
    ok: blockers.length === 0,
    compliance,
    idleFloor,
    findings,
    summary:
      blockers.length === 0
        ? `Budget review PASSED — cheapest-correct. ${findings.find((f) => f.id === "all-in-baseline")!.detail}`
        : `Budget review found ${blockers.length} blocker(s): ${blockers.map((f) => f.title).join("; ")}.`,
  };
}
