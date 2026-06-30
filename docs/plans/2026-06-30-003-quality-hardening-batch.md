# Quality-hardening batch (pre-launch) — 2026-06-30

Execute in a FRESH context. All four items are $0 / offline except where noted (Item 4
verification + the deferred regenerations need a live model — GLM credits return 2026-07-01).

## Where we are (this session's outcomes, branch `feat/pre-launch-followups`)
- **5 gate false-positive classes fixed** (all pushed, 332 api tests green): datastore
  tier-ladder (`2729e08`), phantom NAT (`2729e08`), WAF/Shield/NAT orphans (`01dafbd`),
  CloudWatch-Dashboards-as-datastore + DynamoDB-message-store-as-queue (`78c3276`).
- **Posture strengthened** (`fe6244f`): budget collapses managed framing BY DEFAULT (not
  only "cost-first"). Opus-proxy verified (ct-ecommerce $116→$12, ct-steady $162→$49,
  13/13). **NEEDS a live GLM/Sonnet confirm that Sonnet complies** before promoting
  `budgetTierIsCostHonest` to a hard gate.
- **Deterministic TF emitter MERGED** (PR #10, `8c049fd`): now covers ALL tiers, terraform-
  validated, 100% dogfood coverage. Trading budget.tf already regenerated gap-free (`6ea152c`).
- **Corpus audit found 3 of 10 SERVED designs fail the current gate** (Item 1 below).
- 8 good drafts preserved to `dogfood/corpus-candidates/` (Item 3 below).

---

## Item 1 — Fix the 3 failing served designs ($0 to hide; regen needs a model)
The corpus audit (4 approved gens + 6 curated) found 3 below the current bar — being served:
- **`7uuam9-_SRkK`** (approved gen, the **trading** app): `graphHasNoDanglingEdges` — edges
  from `tradingview` and to `operator_email` / `slack_webhook` (undeclared nodes).
- **`YotQu2CRb92_`** (approved gen, paste-bin): `queuesAreResilient` — resilient queue with
  no idempotency/dedupe mention.
- **`url-shortener`** (curated): `graphHasNoOrphanNodes` — resilient Lambda `fn_create_s` orphan.

**Do now ($0):** set `status='hidden'` on the two approved generations so they stop being
served. `curated_runs` has NO status column — either delete the `url-shortener` row or add a
status/hidden mechanism (decide: a `hidden` column on `curated_runs` is the clean fix).
Re-run the corpus audit (script below) → every served design must be 13/13.

**Defer (needs a model):** regenerate all 3 cleanly under the current pipeline + posture
(GLM 2026-07-01), re-review, re-approve. The trading one's dangling edges are the Item-4
pattern, so fixing Item 4 first will make its regen clean.

Corpus-audit script (reads root DB, runs the gate + floor on approved gens + curated):
```ts
// apps/api/scripts/_corpusAudit.ts — see this session's transcript; reads
// C:/Projects/stackdraft/data/drafture.db; for each approved gen + curated_run:
// runAllProperties(d) + budgetIdleFloor(d) + budgetTierIsCostHonest(d).
```

## Item 2 — Regenerate both dogfood packs' TF (all tiers) from the merged emitter ($0)
The emitter is now on-branch (`apps/api/src/pipeline/terraform/assemble.ts`,
`assembleTier(tier, {region})` → `{ code, coverage.unsupported }`). Verified: BOTH packs
emit FULL coverage / 0 wire-up-gap blocks across budget/balanced/resilient.
- **Trading** (`dogfood/trade-monitoring-handoff/`): budget.tf already regenerated (`6ea152c`)
  but at emitter `2e702f2`; the merge added DynamoDB/API-GW emitters (`2495564`) AFTER — so
  REGENERATE budget.tf from the merged emitter to be safe, and ADD `balanced.tf` + `resilient.tf`.
- **Happyhour** (`dogfood/happyhourfriends/`): REPLACE the old LLM `budget.tf` (3 gaps) with the
  emitter output, and ADD `balanced.tf` + `resilient.tf`. The old `cloudfront-origin-tls` gap is
  now a required `variable "origin_domain"` (operator supplies a domain+cert for the EC2 origin) —
  NOT a silent failure. Update `happyhourfriends/DRAFTURE.md` to close the wire-up-gap bullets
  (mirror what was done for trading's DRAFTURE.md in `6ea152c`); remaining work = EC2 app
  (Docker Compose) + `origin_domain` + secrets.
- Emitter output already carries the REFERENCE header. Per-tier write:
  `writeFileSync('dogfood/<pack>/<tier>.tf', assembleTier(tier,{region:'us-east-1'}).code)`.

## Item 3 — Persist the 8 preserved drafts → review → approve → backfill ($0)
Source: `dogfood/corpus-candidates/*.json` (8 designs, all re-gated 13/13 + cost-honest at
preservation). Descriptions: the 7 golden ones = `GOLDEN_PROMPTS[<id>].description`;
`drafture-self` = `dogfood/corpus-candidates/drafture-self.prompt.md`.
1. Persist each as `pending` via `ctx.stores.generations.upsert({...})` (mirror `growCorpus.ts`
   but read the EXISTING body from the json — NO LLM call; just upsert body + description + tags
   via `tagDesign(design)`).
2. `reviewGenerations.ts approve <id>` for each.
3. `backfillEmbeddings.ts` → corpus 11 → 19 (better retrieval = cheaper future gens), gallery seeded.

## Item 4 — Recurring external-edge pattern (needs analysis; fix-verify needs a model)
Pattern seen across trading (`7uuam9`), `ct-steady`, url-shortener, happyhour: edges reference
EXTERNAL PRODUCERS (`tradingview`, a webhook source) and ALERT SINKS (`operator_email`,
`slack_webhook`, `ops_email`, `oncall_email`) that are never declared as nodes — so
`graphHasNoDanglingEdges` / `graphHasNoOrphanNodes` flag them. Only `client` is whitelisted today.
Three approaches:
- (a) GATE: whitelist a small set of external pseudo-nodes — RISKY, masks real dangling bugs.
- (b) GENERATION (preferred): prompt nudge in `ground.ts` to DECLARE external producers/sinks as
  explicit nodes (an "External: TradingView (webhook source)" node; an SNS-subscription node for
  email/Slack alert delivery). Cleaner, fixes the graph at the source — needs a GLM verify run.
- (c) Deterministic post-process: materialize a declared node for a recognized external endpoint an
  edge references. $0-verifiable but adds inferred nodes.
**Recommendation:** lean (b); analyze first. This also makes the trading-design regen (Item 1) clean.

## Deferred until GLM credits return (2026-07-01)
- Live confirm the posture change collapses container/relational budgets on Sonnet → then PROMOTE
  `budgetTierIsCostHonest` to a hard gate (add to `ALL_PROPERTIES`) + re-check `readPathWhenUiImplied`.
- Regenerate ct-ecommerce + ct-steady (bloat) and the 3 hidden served designs under the confirmed posture.
- Item 4 (b) verification.

## Cost discipline (carry forward)
Verify OFFLINE on saved JSONs ($0). Prompt/posture changes test on GLM (free) or Opus-proxy. Paid
Sonnet ONLY for a final batched confirm, with explicit greenlight, ALWAYS backgrounded. See
[[stackdraft-cost-discipline]] / [[stackdraft-verify-cheaply]].
