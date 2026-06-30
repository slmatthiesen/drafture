# Tiered security floor + cost-honest tiers — generate 3 tiers cheaply, correctly, fast

**Status:** plan (2026-06-30). **Owner decision captured:** *budget should mean budget* — the
free structural security baseline only; anything paid that can be bolted on later moves up the
robustness ladder. This plan makes the generator produce that, by default, every time.

**North star (non-negotiable):** WE are the expert and the checker. The quality bar lives INSIDE
our own gates and critics — the system must catch its own over-builds, dangling graphs, and
dishonest costs BEFORE any handoff. If an external reviewer has to tell us a budget is over-built,
our gate has already failed. Every fix below is therefore paired with a check that makes the same
judgment automatically, so "another agent pushed back" stops being how we find problems.

## 1. The problem, named (why reviewers keep pushing back)

A generated budget tier carries **paid enterprise security** that the use case doesn't need:
WAF web-ACL (~$8/mo), 3 customer-managed KMS keys (~$3/mo), multi-region CloudTrail. At
low-traffic / none-sensitivity profiles that's ~85% of the bill — all of it **bolt-on, not
structural**. Two concrete root causes in the code:

1. **The security floor is tier-invariant, and the KB orders the *paid* variant.**
   `packages/kb/security-baselines.json` has no tier field. Worse, two baselines hard-code the
   expensive option as mandatory:
   - `edge-protection`: "CloudFront **plus AWS WAF** (managed rule groups + rate-based)".
   - `encrypt-at-rest`: "**prefer customer-managed keys**".
   `ground.ts` then tells the model "budget carries the ENTIRE floor too", and the emitter obeys
   (`cloudfront.ts` always emits the WAF; `baseline.ts` always emits CMKs; `observability.ts`
   hard-codes `is_multi_region_trail = true`).
2. **The cost-honest gate is blind to paid security.** `costFloor.ts` sums only
   `ALWAYS_ON_SERVICE_KEYWORDS` (NAT/ALB/RDS/EC2/cache…). WAF/KMS/CloudTrail/Secrets-Manager are
   *priced* (`cost.ts:190`) but never enter the idle floor, so `budgetTierIsCostHonest` certifies a
   budget that's actually carrying $15-25/mo of optional security. The gate can't catch the
   over-build it's supposed to catch.

Net: the generator emits a budget a senior reviewer rejects as over-built, and nothing internal
flags it first. That is the entire pushback loop.

## 2. The principle (the rule that ends the debate)

**Budget = cheapest CORRECT.** "Correct" = the FREE STRUCTURAL security floor + the leanest
topology that works. Every PAID security control rides the SAME robustness ladder as NAT / ALB /
multi-AZ: it enters at **balanced**, hardens at **resilient**.

**The keep/defer test — a control stays in budget only if BOTH are true:**
- (a) it is ~$0/mo, AND
- (b) it is painful/structural to retrofit later.

Paid **and** easily-added-later ⇒ defer up the ladder. (WAF is the textbook defer: ~$8/mo and a
5-minute `web_acl_id` attach.)

**The one override — compliance/sensitivity promotes the paid floor into budget.** If intake flags
regulated data (PCI/HIPAA/PII) or non-trivial sensitivity, the paid controls become
CORRECT-required, so they belong in budget too (budget is cheapest *correct*, not cheapest). The
intake **data-sensitivity / compliance** answer is the switch. none-sensitivity (happyhour,
trading) ⇒ lean budget; PCI checkout ⇒ full floor at every tier. This is what makes the rule
*correct*, not merely cheap — and it's the nuance that pre-empts "you made budget insecure".

## 3. The canonical keep/defer line (this becomes DATA, not prose)

Re-express the 8 baselines as a free **structural floor** (all tiers) + **paid enhancements**
(ladder). Each baseline/mechanism gets `tierFloor: budget | balanced | resilient` and an
`escalatesUnderCompliance: true|false` flag.

| Control | Budget (default, none-sensitivity) | Ladder step-up | $/mo | Retrofit |
|---|---|---|---|---|
| S3 Block Public Access | ✅ keep | — | $0 | structural |
| Encrypt in transit (TLS, deny plaintext) | ✅ keep | — | $0 | structural |
| Least-privilege IAM (scoped roles, no wildcards) | ✅ keep | — | $0 | structural |
| No public data tier (private/managed/localhost) | ✅ keep | — | $0 | structural |
| IMDSv2 / tight SGs | ✅ keep | — | $0 | structural |
| Encrypt at rest | ✅ keep via **SSE-S3 / AWS-managed KMS** | **customer-managed CMK** @ balanced+ | $0 → $1/key | easy |
| Secrets | ✅ keep via **SSM Parameter Store (SecureString)** | **Secrets Manager** (rotation) @ balanced+ | $0 → $0.40/secret | easy |
| Edge protection | ✅ keep via **CloudFront + Shield Standard** (free) | **WAF web-ACL** (managed + rate rules) @ balanced+ | $0 → ~$8 | trivial (attach) |
| Audit / access logging | ✅ keep via **single-region CloudTrail → S3** (first trail's mgmt events free) | **multi-region trail + CW-Logs delivery + VPC Flow Logs** @ balanced/resilient | ~$0 → $$ | easy |

Result: a none-sensitivity budget floor = **box + EBS + S3/CloudFront/Lambda usage** (~$0 for
serverless, ~$25-35 for a single box) — not $45-65. Under compliance, the right column collapses
back into budget.

## 4. The changes, layer by layer (each step → verify)

**Step 1 — KB: tier-classify the floor.** `packages/kb/security-baselines.json`: add `tierFloor`
+ `escalatesUnderCompliance` to each baseline; split the two "paid-baked-in" rules so the
**free** part is the budget floor and the **paid** part is a named ladder enhancement (new
`security-enhancements.json` or an `enhancements[]` block on the baseline).
→ *verify:* a unit test asserts every baseline has a tierFloor; the free set is exactly the $0
structural controls.

**Step 2 — prompt (`ground.ts`).** Replace "budget carries the ENTIRE floor" with the tiered
rule: budget gets the **free structural floor**; WAF web-ACL / customer-managed KMS / multi-region
CloudTrail / Secrets-Manager are **balanced+ step-ups stated in the tier delta + a keyDecision**
(exactly like NAT/ALB today). Add the compliance override: when intake flags
sensitivity/compliance, pull the paid floor down into budget. Tag nodes accordingly (budget edge
node tagged "CloudFront + Shield"; balanced edge node tagged "WAF").
→ *verify:* GLM regen of happyhour + trading budgets shows no WAF/CMK/multi-region-trail nodes;
balanced introduces them in its delta; a PCI golden prompt keeps them at budget.

**Step 3 — emitter (deterministic, $0).**
- `baseline.ts`: budget KMS = AWS-managed (SSE) — emit a customer CMK only at balanced+ (or when
  a node is tagged compliance). `cloudfront.ts`: emit the WAF web-ACL only when the tier carries a
  "WAF" tag (balanced+). `observability.ts`: `is_multi_region_trail = tier === resilient` (single
  at budget/balanced); defer CW-Logs trail delivery + Flow Logs to balanced+.
- These are tier-conditioned the same way networking already gates NAT/ALB.
→ *verify:* `scripts/tfStressTest.ts --designs dogfood` stays 100% coverage / 0 gaps /
terraform-valid; budget.tf no longer contains `aws_wafv2_web_acl` / 3 CMKs / multi-region trail;
balanced.tf does.

**Step 4 — cost engine sees ALL fixed security cost.** Ensure WAF / KMS / CloudTrail / Secrets
Manager are priced AND surfaced as cost-driver lines (so the cost table is honest and the idle
floor can see them). Add KMS/CloudTrail/Secrets to the pricing seed if missing (WAF already there).
→ *verify:* the cost table for a budget tier lists every fixed monthly line; no hidden security $.

**Step 5 — gate: make `budgetTierIsCostHonest` see paid security, then PROMOTE it.**
- Extend the idle floor (or add a sibling check `budgetHasNoPaidSecurityFloor`) to count
  fixed-cost security services (WAF, customer-CMK, multi-region trail, Secrets Manager) on the
  budget tier — UNLESS the design is compliance-flagged.
- Once the dogfood + golden set are green under the new posture, add `budgetTierIsCostHonest` to
  `ALL_PROPERTIES` (hard gate) so an over-built budget can never be served again.
→ *verify:* the gate fails today's over-built happyhour/trading budgets and passes the regenerated
lean ones; the PCI golden prompt is exempt and passes with the floor present.

**Step 6 — internalize the adversarial reviewer (this is what stops the pushback).** The external
agents are doing a *cost-honesty + fit* review by hand. Build it in: a deterministic
"senior-architect budget review" that runs pre-handoff and emits the verdict the reviewers give —
(1) paid-security-on-budget (Step 5), (2) the always-on quartet check (exists), (3) honest
all-in baseline stated. Optionally an LLM-judge pass for "re-platform vs bolt-on / does it fit the
stated setup" framed as advisory notes in the handoff doc, not a blocker.
→ *verify:* run it on the current dogfood packs — it reproduces the trading agent's "over-built
security" finding before any handoff.

**Step 7 — regenerate + re-gate the corpus & dogfood.** Once 1-6 land: regen happyhour + trading
all tiers (deterministic TF is $0), regen the corpus's container/relational designs on GLM,
re-run `_corpusAudit.ts`. The 3 currently-hidden designs regenerate clean under the new posture.
→ *verify:* `_corpusAudit.ts` = every served design 13/13 **and** cost-honest; dogfood budgets
read ~box-only.

## 5. Cheap + fast (the other half of the ask — already mostly solved, keep it)

Generation is already cheap and fast; this plan adds **no** runtime cost:
- **Terraform = $0, instant, deterministic** (the emitter; no LLM for IaC). Steps 3 are emitter
  edits — still $0.
- **Design generation** is the only LLM spend: tier-delta emission (~17-30% fewer output tokens),
  the retrieval corpus (instant-serve / grounding), and **GLM-4.5-flash = $0** for generation +
  verification. Net new spend to execute this plan ≈ free (GLM regen + Voyage embeddings).
- Keep verifying **offline on saved JSONs**; paid Sonnet only for a final batched confirm with an
  explicit greenlight.

## 6. Steelman / risks a reviewer would raise (answered, so they can't blindside this)

- *"No WAF = insecure public box."* CloudFront + **Shield Standard** (free, automatic, L3/L4) stay;
  CloudFront/API-Gateway give basic rate-limiting. WAF is **L7 rule filtering** — add it the day you
  have traffic/threats worth filtering (a one-line `web_acl_id`). Documented add-back in the brief.
- *"AWS-managed keys aren't auditable."* SSE with AWS-managed keys still encrypts at rest (baseline
  satisfied). Customer-managed CMK adds rotation control/audit — a balanced+ concern, or budget
  under compliance.
- *"You'll relax security for someone who needs it."* The compliance/sensitivity override (Step 2/5)
  pulls the full floor into budget exactly when the data warrants it. Lean is the *default*, not the
  only mode.
- *"This re-platforms my existing system."* Separate decision (the trading agent's other point):
  whether to ADOPT a generated design vs bolt onto an existing box is the user's, and the handoff
  doc (Step 6) states it explicitly rather than pretending the stack is a drop-in.

## 7. Definition of done (measurable)

1. KB baselines carry `tierFloor` + compliance flag; tests assert the split.
2. `ground.ts` produces tiered floors; GLM regen confirms compliance.
3. Emitter: budget.tf has **no** WAF / customer-CMK / multi-region trail (none-sensitivity);
   balanced.tf introduces them; `tfStressTest` 100%/0-gap/valid holds.
4. Cost table lists every fixed security line; idle floor sees them.
5. `budgetTierIsCostHonest` flags paid-security-on-budget, is exempt under compliance, and is a
   **hard gate** in `ALL_PROPERTIES`.
6. The internal budget-review reproduces the external "over-built" finding pre-handoff.
7. happyhour + trading budgets regenerate to ~box/serverless-only; `_corpusAudit.ts` all green.

## 8. Suggested execution order (small, sequenced, each independently verifiable)
KB (1) → gate-sees-paid-security + cost lines (4,5a) → run gate on current dogfood to PROVE it now
fails them (locks the regression) → prompt (2) → emitter (3) → regen + re-gate (7) → promote gate to
hard + internal reviewer (5b,6). Do KB+gate FIRST so the failing-then-passing transition is the
proof the fix works.
