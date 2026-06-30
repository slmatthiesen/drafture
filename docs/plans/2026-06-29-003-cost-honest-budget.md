# Cost-honest Budget tier — 2026-06-29

The most important gap found pre-launch. Surfaced by generating the happy-hour pack and
confirmed by the corpus proof batch: the **Budget tier over-provisions** — it reaches for
the always-on managed quartet (NAT + ALB + Fargate/ECS + RDS/Aurora, sometimes
ElastiCache) and quotes a cost-conscious user a $100–400/mo *idle floor* for a workload
that should cost ~$0–40.

## Evidence
- Happy-hour budget tier: **$109–224/mo** idle floor (NAT $33, Fargate ~$30, ALB $22,
  RDS $12, WAF $5). The user runs the same workload today on a single box for ~$25–40.
- Corpus proof batch (all passed the 13-property gate):
  - sl-webhook-receiver $1–12/mo (serverless) ✓
  - qa-order-processing $10–105/mo (serverless) ✓
  - ss-spa-dashboard $12–292/mo (serverless; floor ok) ✓
  - **ct-ecommerce-api $167–423/mo** (ALB+Fargate+ElastiCache+RDS+NAT) — bloat, **certified 13/13** ❌
- **Key realization:** the gate measures STRUCTURE (no dangling edges, datastore reachable,
  security floor present), not RIGHT-SIZING. A bloated design passes. Auto-approving
  gate-passers would seed the corpus with the bloat (served verbatim).

## Agreed definition (operator)
**Budget = the cheapest *correct* way to get going: minimum safety floor, and a *path* to
scale — NOT scale pre-provisioned.** Scalability comes from the LADDER (Budget → Balanced →
Resilient), not from over-building Budget. The moment Budget pre-builds scale (ALB/Fargate/
multi-AZ) it has become Balanced.

## Posture for Budget (priority order)
1. **Serverless-first** (Lambda / DynamoDB / S3 / API Gateway / SQS) — ~$0 idle, auto-scale.
   The default whenever the workload fits. Preferred over a box.
2. **Single box** (EC2 / Lightsail + Docker Compose, self-managed Postgres w/ pg_dump→S3)
   — ONLY when the workload genuinely needs persistence/stateful/special runtime serverless
   can't do cheaply (ISR in-process cache, websockets, **PostGIS**, big-memory headless
   Chromium if not Lambda). Do NOT force single-box when serverless is viable.
3. **Managed-services split** (NAT + ALB + Fargate/ECS + RDS/Aurora) — this is **Balanced /
   Resilient** territory. Budget should not default here just because the brief used those
   words. Challenge "managed Postgres / containerized / scale independently" framing when
   cost is priority #1 and scale is tiny.

The hard cases (why happy-hour is genuinely tricky): ISR persistence resists pure Lambda,
and **PostGIS has no scale-to-zero option** (Aurora Serverless v2 min ~0.5 ACU ≈ $43/mo;
RDS t4g.micro ~$12; box ~$0-extra) — so a small always-on floor for the DB is sometimes
unavoidable. That's fine. The bug is STACKING the whole quartet, not a single justified store.

## Two-part fix
1. **Posture (the real lever) — prompt/KB:** teach Budget the serverless-first → single-box →
   (managed-split only at Balanced+) hierarchy, and to challenge managed framing on cost.
   Make the security floor FLEX: "private data subnet + NAT" is the right default at scale,
   but a hardened single host (Postgres on localhost, tight SG, TLS at edge) is a legitimate
   floor-satisfying pattern that must not force a $33 NAT on a hobby deployment.
2. **Idle-floor gate (the guardrail — measurable):** a deterministic property that computes
   the budget tier's ALWAYS-ON monthly floor (sum the minimum cost of always-on services:
   NAT, ALB, RDS/Aurora-provisioned, ElastiCache, Fargate/ECS/EC2-always-on) and flags an
   excessive floor (a single justified store passes; the stacked quartet fails). Start
   WARN-ONLY, calibrate the threshold against the golden set (serverless ones pass,
   ct-ecommerce/happy-hour flag), then promote to a hard gate. This is what PROVES the
   posture works and prevents regression.

## Corpus implication
- `ct-ecommerce-api` (LJhAwNMIjZR1) HIDDEN from the pending queue (bloated output, not a bad
  prompt). **Re-run the prompt after the posture fix** to see a leaner design, then re-review.
- Keep sl-webhook-receiver / qa-order-processing (good); glance at ss-spa-dashboard's high end.
- Do NOT approve bloated "budget" designs into the corpus — they get served verbatim.

## Open decision
Re-scope **Budget** to mean cheapest-correct (operator leans yes; happy-hour's current Budget
becomes Balanced), vs. a new tier below Budget. Leaning re-scope (three tiers is the right count).

## Sequence
1. ✅ **DONE** — idle-floor gate (warn-only) + reproducible report. `src/pipeline/costFloor.ts`,
   `budgetTierIsCostHonest` property (warn-only, not in ALL_PROPERTIES), `scripts/costFloorReport.ts`.
   Calibrated: serverless $0 / single box $12 pass; managed stacks $69–150 flagged. 322 tests green.
   Also HID an already-approved bloated corpus design (`b4ao9aRmoVwo`, $68.89) + `ct-ecommerce-api` (`LJhAwNMIjZR1`).
2. ✅ **DONE** — the serverless-first POSTURE change (prompt/KB). `ground.ts` SYSTEM_PROMPT now teaches
   the explicit budget hierarchy (serverless-no-VPC → single box → managed split only at Balanced+),
   CHALLENGES managed framing ("containerized"→Docker Compose on a box not Fargate; "managed Postgres
   +PostGIS"→self-managed on the box not RDS; "scale independently"→co-located now, split at Balanced),
   and adds a HARD RULE: already-on-one-host + cost-first ⇒ budget MUST be that single box. Also
   tier-qualified the matched-reference-architectures header (patterns = the SCALED shape; budget must
   collapse them — this was actively pulling budget toward the container-api quartet). Security floor
   FLEXED: `security-baselines.json` no-public-data-tier now recognizes a co-located localhost store
   (shape c) as already-private — no forced private subnet/NAT.
3. ✅ **DONE (verified honest)** — regenerated happy-hour on Sonnet (prod path): budget floor
   **$102.86 → $12–45/mo** (run variance; both pass `budgetTierIsCostHonest`). Now a single EC2 box
   (Docker Compose: web + orchestrator + self-managed Postgres/PostGIS) + render→Lambda + S3/CloudFront,
   NO ALB/Fargate/RDS/NAT. (Did NOT enshrine into `dogfood/happyhourfriends/` yet — see follow-ups.)
   Still TODO: re-run `ct-ecommerce-api` via `growCorpus.ts --ids ct-ecommerce-api` + re-review.
4. ⬅ **NEXT: fix the 2 gate gaps the re-runs exposed (below), THEN promote.** Run the full golden set
   (~$2-3 design-only) to confirm floors drop broadly, then PROMOTE `budgetTierIsCostHonest` to a hard
   gate (add to ALL_PROPERTIES) + re-promote `readPathWhenUiImplied` if validated. Don't promote on a
   single design, and don't promote until the two gaps below are fixed (else honest single-box designs
   flake the gate).

## Re-run findings (2026-06-30, design-only, ~$0.18 total) — posture CONFIRMED on 3 systems
- **notification (high-value test):** budget = PURE SERVERLESS, $0 idle, gate **13/13**, AND fully
  durable (outbox/exactly-once, SQS+DLQ+idempotent consumers, SES event publishing, immutable billing
  ledger). PROVES the posture does NOT over-cheap a critical system — serverless-first IS the durable
  choice here. (`scratchpad/notif/`)
- **ct-ecommerce-api (`LJhAwNMIjZR1`, bloat case #2):** LEANED OUT — budget dropped its RDS (that's
  what tripped the datastore check). Gate 10/13: the failures are NOT bloat (see gap A + a model
  `oncall_email` dangling-edge typo + queue-tag variance). `$0.091`.
- **b4ao9aRmoVwo (another happy-hour-class brief):** collapsed to a single EC2 box + self-managed
  Postgres; budget clean (12/13, orphans only in balanced/resilient). But floor read **$45 via a
  PHANTOM NAT** (gap B). (`scratchpad/selfhost/`)

## TWO gaps to fix before promotion (both $0 — code + offline verify, NO API)
- ✅ **DONE — A. `datastoreMatchesDecision` false-positive on a TIER-LADDER datastore decision.** The
  `vpcbound`-decision branch checked PER TIER ("this tier has no VPC-bound store → fail"), contradicting
  its own docstring ("no such store *anywhere*"). Split the two directions: the serverless↔vpc-node
  check stays PER TIER (that NAT harm is local), but the vpcbound "store absent" check is now
  DESIGN-WIDE — contradicted only when NO tier draws the store. A budget that defers RDS to balanced+
  passes; a vpcbound decision whose engine no tier draws still fails. `properties.ts` + tier-ladder
  fixture (`tierLadderDatastoreArchitecture`) + over-relaxation guard. Verified offline on the scratch
  designs (selfhost/ct-steady-api/hh-final all pass; controls still fail).
- ✅ **DONE — B. Phantom NAT in the cost engine on a single-box budget.** The NAT trigger keyed on the
  broad `VPC_PRIVATE_SERVICE_KEYWORDS` (which includes bare compute EC2/Fargate/ECS/EKS), so a single
  EC2 box defaulted to "private" → a ~$33 phantom NAT (inflated $24→$45). Added a narrower
  `PRIVATE_DATA_TIER_KEYWORDS` (managed engines the no-public-data-tier baseline ALWAYS makes private:
  RDS/Aurora/ElastiCache/OpenSearch/…); `egressesFromPrivateSubnet` now synthesizes NAT ONLY when the
  tier runs such an engine (not public-tagged) OR literally draws a NAT node. Bare compute alone never
  trips it. The broad list still drives `sanitize.ts` unchanged. Verified offline: hh-final/selfhost
  budgets $45→$12 (match the public-tagged hh-sonnet2), ct-steady-api keeps its NAT (real RDS+NAT nodes).
  `cost.ts` + cost.test.ts (single-box-no-tag + NAT-node tests). 329 api tests green, typecheck clean.

  **Promotion is now unblocked** (the two false-fail classes are gone): run the full golden set
  (~$2–3 design-only) to confirm budget floors drop broadly, THEN add `budgetTierIsCostHonest` to
  `ALL_PROPERTIES` (+ re-check `readPathWhenUiImplied`). Not done here — that step costs API.

## Open follow-ups
- ✅ **DONE** — `computeMatchesDecision` HYBRID false-positive: now per-service scoped (serverless
  decisions check only the nodes they name; always-on stays tier-wide). `properties.ts`. The honest
  hybrid budget (EC2 box + Lambda render) no longer false-fails.
- ✅ **DONE** — delta-reconstruction dangling edges: `applyTierDelta` (architecture.ts) now prunes
  edges whose endpoint a delta removed (the bigger budget→balanced delta from the box→managed-split
  posture was producing these). Targeted (only explicitly-removed ids) so it never masks a typo'd id.
- ✅ **DONE** — dogfood pack refreshed (commit 9e836fe) to the single-box budget ($25/1svc); DRAFTURE.md
  + README rewritten. Used the already-generated hh-pack1 artifacts ($0). budget.tf 84 resources.
- 3 corpus designs still PENDING approval (sl-webhook `kZg3E8YdaeOm`, qa-order `1B_GyLhZ-m0z`,
  ss-spa `CE7zSZRS5wbz`) — all serverless/cost-honest; approve + `backfillEmbeddings.ts` when ready.
- **Speed (raised this session):** consumer design call ≈ ~90–130s (out ~6.7k tokens is the bottleneck);
  the 8-min figure was the offline `--tier all` pack (1 design + 3× 32k-token Terraform). Lever:
  stream/progressively render tiers + loading anim; push more fixed content into the deterministic KB.
