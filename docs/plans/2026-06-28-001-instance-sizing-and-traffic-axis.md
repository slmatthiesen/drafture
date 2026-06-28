# Instance sizing + traffic-as-its-own-axis (cost honesty, round 2)

**Date:** 2026-06-28 · **Status:** 🚧 PLANNED — execute in a fresh session
**Memory:** `stackdraft-cost-model-pricing-gaps.md`
**Builds on (all merged to main):** decision-graph coherence + NAT reframe + 3 cost-engine fixes
(phantom Fargate / request-vs-capacity double-count / phantom NAT). Self-host example regenerated honest.

This is the **GAP-1 root-cause fix** (cheap-instance pricing) plus the **tier-philosophy decision**
they're entangled and should land together.

---

## Problem 1 — the engine discards the architect's instance size (the m5.large bug)

The "staff architect" already right-sizes: the self-host design literally wrote
`ECS on EC2 (t4g.small)` in the node AND `t4g.small` in the keyDecision. But the cost engine
**ignores it** — it reads only `awsService` → one fixed seed price (`EC2 = $0.096/hr = m5.large`).
So a t4g.small ($12/mo) box is priced as m5.large ($70/mo). The architect made the right call; the
engine threw it away.

**Why it wasn't caught:** cost tests assert the *formula* (`price × band × multiplier`), never
"does the priced size match the size the architect chose." A $70 m5.large passed green tests.

**Audit result (all 6 curated, 2026-06-28):** 5/6 are pure Lambda → usage-priced, NO instance size,
already correct. The over-count fear (microservice fleets) did NOT materialize — notification-system
resilient has 8 Lambdas across 2 regions and costs ~$1.67/mo total (Lambda is per-invocation). The
bug bites ONLY the one design with a real instance (self-host). Narrow, not systemic.

## The double-apply trap (why server-only fix is wrong)

Two size systems fight:
- **Server** `cost.ts`: prices EC2 at the single seed price = m5.large.
- **Client** `TierTabs.tsx:62`: re-scales by a per-tier RATIO (budget→0.22), ratio relative to
  "medium = m5.large".

Today's budget display $15.59 = `$70 × 0.22` — right number, wrong reasoning. If the server is fixed
to price t4g.small ($12) and the client still multiplies by 0.22 → **$2.60 (double-applied)**. So the
fix MUST be two-sided.

## Fix 1 design — unify on ONE absolute instance-price table (honor architect, else tier default)

Decision (user, 2026-06-28): **"Honor architect's size, else tier default (budget→small, never
large)."** Implementation:

1. **`packages/kb/instance-prices.seed.json`** (new, shared by api + web): `instanceType → usd/hr`,
   Graviton-first — t4g.{nano,micro,small,medium,large}, m7g.{large,xlarge}, db.t4g.*, cache.t4g.*,
   r6g.* etc. Real us-east-1 on-demand $/hr. Replaces the single-price-per-service guess.
2. **schema** (`architecture.ts`): add optional `instanceType?: string` to `CostDriverSchema` so the
   server can tell the client what it priced (kills the ratio guesswork).
3. **server** (`cost.ts`): for a capacity (hour-unit) service, resolve the instance type:
   (a) PARSE it from the node text if the architect stated one (`t4g.small`, `db.r6g.large`, …);
   (b) else TIER DEFAULT by service family (budget→small, balanced→medium, resilient→large — NEVER
   m5.large-always). Price = `INSTANCE_PRICES[type] × hours-band × tierMultiplier`. Stamp
   `instanceType` on the driver.
4. **client** (`sizeLadder.ts` + `applySizeSelection` + `TierTabs.tsx`): ladder becomes a MANUAL
   override using ABSOLUTE prices from the same table (no ratios). Default selection = the driver's
   `instanceType` from the server; remove the per-tier auto-ratio seeding.
5. **tests**: assert priced size MATCHES stated size (the missing invariant); tier-default when
   absent; double-apply guard. **Recompute curated** (no LLM).

This DELETES the ratio-guessing the user objected to — the engine prices what the architect chose.

---

## Problem 2 — tier philosophy: is traffic its own axis? (RECOMMENDATION: yes)

Two conflicting models collide today:
- **Current (tier-scale-ladder):** the 3 tiers ARE the traffic ladder (budget=1k/day … resilient=
  100k/day). Volume intrinsic to tier; engine scales cost by tier (`TIER_VOLUME_SCALE` 0.1/1/10×).
  Traffic intake was REMOVED because the tier encodes it.
- **User's instinct + the coherence prompt + the regenerated self-host example** all assume tiers =
  ROBUSTNESS variants (single-AZ → multi-AZ → multi-region) at ONE traffic level.

These can't both be true (resilient shouldn't force 100k/day if the user has 1k/mo).

**Recommendation (Claude): make traffic its own axis. Reverse the tier-as-traffic-ladder.** Reasons:
- Users think about traffic and reliability-spend as SEPARATE questions. Welding them produces the
  exact nonsense hit here (a budget box priced for a traffic level never specified).
- The user KNOWS their traffic — it's the one input they can give confidently. Inferring it from a
  tier label is backwards.
- "Three ways to run YOUR app — cheap / balanced / bulletproof" is the honest architect conversation;
  "three different-sized apps" is not what anyone asked for.
- It SIMPLIFIES cost logic: `TIER_VOLUME_SCALE` (per-tier volume) is replaced by ONE traffic-driven
  volume (same across tiers); tiers differ only via the robustness multiplier. Removes a concept.

**User's proposed mechanism (good):** one intake toggle — expected monthly visitors, e.g.
`<1k / <50k / <500k / millions` — passed to the agent so sizing/volume is unambiguous. KEEP IT
OPTIONAL with a sensible default (e.g. <50k/mo) stated in assumptions, so skippable-intake UX
survives. Customer does NOT pick capacity (that's the agent's job); they only state traffic.

Touches: `IntakeForm.tsx` (+1 question), the prompt's TIERS/TIER-CONTENT/volume guidance, `cost.ts`
volume model (traffic-driven not tier-driven), memory `stackdraft-tier-scale-ladder.md` (reverses it),
curated recompute/regen. Moderate but it removes a concept rather than adding one.

**Why land Fix 1 + Problem 2 together:** the volume model changes either way; instance sizing should
be priced against the (now traffic-driven) volume, not redone twice.

---

## Execution order (fresh session)
1. Branch off main.
2. Fix 1: instance-price table + schema field + server pricing + client ladder unification + tests.
3. Problem 2: traffic intake toggle + prompt tier/volume rework + cost volume model + tests.
4. Recompute curated (no LLM); regenerate self-host + any design whose sizing shifts (Sonnet, ~$).
5. Update memory: this file done, `stackdraft-tier-scale-ladder.md` reversed, pricing-gaps GAP-1 closed.

## Caveats
- Instance prices are grounded estimates, not live quotes (consistent with "order-of-magnitude" model).
- Reversing the tier-scale-ladder is a deliberate product decision — confirm before building Problem 2.
- All current main work (coherence/NAT/3 cost fixes) stays; this builds on it.
