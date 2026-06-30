# Item 4 — recurring external-edge pattern: analysis + recommendation (2026-06-30)

> Analysis only (no spend). Implementation + verification need a model run (GLM, 2026-07-01).
> Companion to docs/plans/2026-06-30-003-quality-hardening-batch.md (Item 4).

## The pattern (confirmed)

`graphHasNoDanglingEdges` blesses exactly ONE bare (undeclared) edge endpoint: the literal
`"client"` (see `src/pipeline/completeness.ts:46`). Every other external participant an edge
names — but no node declares — is flagged dangling. `graphHasNoOrphanNodes` is the mirror:
a declared-but-unwired node fails.

The model has internalised `client` as "the one external pseudo-node" and extends that mental
model to OTHER external actors by writing them as bare edge endpoints. Two distinct sub-cases,
seen across trading (`7uuam9`), `ct-steady`, `url-shortener`, happyhour:

- **CASE A — external PRODUCER (inbound).** A third-party webhook source: `from: "tradingview"`
  (also Stripe/GitHub/etc.) with no `tradingview` node. Conceptually like `client`, but inbound
  and a distinct third party. **Genuinely outside AWS — no resource, no cost.**
- **CASE B — alert SINK (outbound).** The terminal of the alert path: `to: "operator_email"` /
  `"slack_webhook"` / `"ops_email"` / `"oncall_email"` with no such node. The model is trying to
  "close the loop" to a human, per the prompt's own instruction (`ground.ts` OBSERVABILITY line:
  "alarm → SNS → email/Slack/PagerDuty **subscription**"). **The delivery mechanism IS an AWS
  resource — an SNS subscription — so this should be a real (≈$0) node, not a bare endpoint.**

So Case B is largely a COMPLIANCE gap with existing guidance (the prompt says "subscription"; the
model draws a human instead). Case A has NO guidance to declare the producer at all.

## Why the three options land where they do

- **(a) GATE whitelist** of external pseudo-nodes — **rejected.** `graphHasNoDanglingEdges` is the
  highest-value completeness check (it catches tier-delta reconstruction bugs — a renamed/typo'd
  node id). The set of external names is unbounded (every SaaS webhook source × every alert
  channel), so a keyword whitelist both weakens the check and is a perpetual guessing game. Wrong
  layer. Strict gate = correct failure mode (reject a dangling design; never serve it).
- **(c) Deterministic post-process** that materialises a node for a recognised endpoint —
  **rejected as the primary fix.** Same unbounded-recognition problem as (a), and it INVENTS graph
  structure the model didn't intend (is `ops_email` a subscription, or a typo of a real node?).
  Band-aid. Its one virtue (verifiable $0 now) is moot since GLM verification is ~free and a day away.
- **(b) GENERATION nudge** in `ground.ts` — **recommended.** Fix the representation at the source
  so the graph is honest and the strict gate stays strict.

## Recommendation: (b), in two parts — but it is NOT a one-line nudge

Declaring external actors as nodes touches downstream layers, because a node's `awsService` drives
cost + Terraform. Verified today:
- **TF**: an unknown `awsService` → `serviceKey.ts` returns `"unsupported"` → `assemble.ts` emits a
  TODO block AND drops the tier below 100% coverage. An "External: TradingView" node would break the
  dogfood 100%-coverage / 0-gap story unless the emitter recognises and SKIPS it.
- **Cost**: prices by service-name match; an unrecognised service contributes no line (≈$0, no
  crash) — so cost is tolerant, but a guard makes the intent explicit.

### Part 1 — prompt convention (ground.ts)
Add a short, explicit "EXTERNAL ACTORS" rule:
1. `client` is the ONLY bare (undeclared) edge endpoint allowed.
2. **CASE A:** a third-party PRODUCER (webhook source — TradingView/Stripe/GitHub/…) MUST be a
   declared node with a reserved marker, e.g. `awsService: "External: TradingView"`, `role:
   "webhook source"`. It is outside AWS (no resource, no cost).
3. **CASE B:** an alert DELIVERY target MUST be a declared SNS-subscription node (`awsService:
   "SNS Subscription"`, `role: "email/Slack/PagerDuty delivery"`) — NEVER a bare email address,
   Slack URL, or human name. (Sharpens the existing "subscription" wording so it's unambiguous.)

### Part 2 — downstream guards ($0, deterministic)
- `serviceKey.ts` / `assemble.ts`: recognise the `External:` marker → emit NOTHING (not a TODO),
  and EXCLUDE it from the coverage denominator (it's not an AWS resource, so it can't be "unsupported").
- `cost.ts`: treat an `External:` node as $0 explicitly (it already contributes nothing, but make it
  intentional so it can never accidentally match a price).
- `completeness.ts` / orphan check: NO change needed — an external producer is wired by definition
  (it's an edge endpoint), and an SNS-subscription node is a normal wired node.
- TF emitter for Case B: the SNS emitter ALREADY appends `aws_sns_topic_subscription` from the SNS
  topic + `ops_email` var (see happyhour `budget.tf`), so a subscription node needs no new resource —
  fold it into the existing SNS handling (or no-op it) so it doesn't read as "unsupported".

### Cheaper minimal variant for Case A (note, not the recommendation)
Overload `client` as "the outside world" — let inbound third-party events also originate from
`client`. ZERO downstream work (client is already gate-blessed, never costed/emitted). Trade-off:
loses the semantic distinction (TradingView ≠ end user) and the producer never appears by name in the
diagram. Prefer the declared `External:` node for diagram quality + honesty; fall back to this only if
the marker+guards prove fiddly.

## Verification plan (GLM, 2026-07-01 — ~free)
1. Land Part 1 (prompt) + Part 2 (guards).
2. Regenerate the trading design (Item 1's `7uuam9`) on GLM → expect `graphHasNoDanglingEdges` clean
   (TradingView a declared External node; alerts to an SNS-subscription node), 13/13, re-approve.
3. Run `scripts/tfStressTest.ts --designs dogfood` → still 100% coverage / 0 gaps (the guard must keep
   External nodes out of the coverage denominator).
4. A small GLM batch over the golden set → confirm the model COMPLIES (declares external nodes) and no
   regression elsewhere. This makes the Item-1 trading/ct-steady regens clean.
