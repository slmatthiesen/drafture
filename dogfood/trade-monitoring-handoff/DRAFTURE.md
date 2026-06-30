# DRAFTURE — agent handoff brief (READ THIS FIRST)

> Source: design from this pack's `prompt.txt` + `answers.json` through the Drafture pipeline
> (tier-delta + wire-up rules + 15-property completeness/cost-honest gate) · model
> claude-sonnet-4-6 · tier: **budget** · region: us-east-1 · `.tf` re-emitted 2026-06-30 under
> the TIERED SECURITY FLOOR (docs/plans/2026-06-30-005).
> Siblings in this pack: `budget.tf` (57 resources — the lean **free** security floor),
> `balanced.tf` (65 — adds the paid floor), `resilient.tf` (70 — + multi-region trail) —
> reference Terraform for all three tiers, emitted deterministically from `design.json`,
> `detectWireupGaps()` = 0 and `terraform validate`-clean on each.

This pack is an **agent-ready build plan**, not a finished stack. Drafture did the
judgment-heavy first 80% (architecture, sizing, security floor, cost). Your job is the
last 20%: turn `budget.tf` into something that `terraform plan`s cleanly and fits the
real repo. **Read every section below before touching the `.tf` — several omissions are
intentional decisions, not bugs.**

---

## 1. What the user actually asked for

> "I make future trades via TradingView alerts. I want to monitor those trades, display
> them in a graph + table for myself and the public. **I already have all of that built
> and hosted.** For right now I just need an endpoint that receives trades from
> TradingView and pushes that data where it needs to go. Later: an AI step that downloads
> trade data and runs Python evaluations on whether the trades were ideal."

Intake: downtime = best-effort · data sensitivity = none · traffic = <1k/mo.

**MVP scope (this pack):** TradingView webhook ingest → durable queue → async Python AI
eval → trade + eval-result store. Idle cost ~$0 (all serverless, no VPC/NAT).

## 2. Intentional scope decisions — DO NOT re-add without asking

These were deliberate. If you "helpfully" add them back, you undo a call the user made.

- **No UI/dashboard hosting.** The user already has the front end built and hosted
  elsewhere. Do **not** provision S3+CloudFront static hosting for a dashboard. The
  CloudFront in `budget.tf` fronts the **ingest API**, not a static site.
- **The existing frontend is fed by a PUSH fan-out, not a read API.** This design wires
  `ingest_lambda → SQS → dispatch_lambda → HTTP POST` to the user's existing frontend
  endpoint (see the `sqs_fanout`/`dispatch_lambda` nodes). The assumption — **confirm it
  with the user** — is that the already-built frontend exposes an ingest endpoint and owns
  its own display store. **⚠ Open gap to verify:** if the frontend instead expects to
  *pull* trades, there is no public GET route over DynamoDB here (IAM grants are
  `PutItem`/`UpdateItem` write-only) — in that case raise it and add either a read Lambda +
  `GET /trades` route or an AppSync endpoint. Do **not** silently assume the push lands
  somewhere usable; **confirm the frontend's ingest contract** (URL, auth, payload) first.
- **AI eval is async.** The webhook returns ~200ms; eval runs from the queue. Do not make
  eval synchronous with the webhook response.
- **No compliance regime.** No PII / regulated data → no HIPAA/PCI scope. Don't invent one.

## 3. Security floor — TIERED (budget = cheapest CORRECT; preserve the free floor)

This is a **none-sensitivity** workload (no PII/regulated data), so `budget.tf` carries the
**FREE structural floor** and DEFERS paid enterprise security up the robustness ladder — the
same way it defers NAT/ALB/multi-AZ. Keep the free floor; the paid items are a one-line add
when traffic/threats justify them.

**Budget free floor (in `budget.tf`, all $0):** TLS everywhere (HTTPS terminated at
CloudFront) · at-rest encryption with **AWS-managed keys** (DynamoDB default SSE, S3 SSE-S3
`AES256`, SQS managed SSE, `alias/aws/sns`) · least-privilege IAM per service, no wildcards ·
S3 Block Public Access on every bucket · **CloudFront + Shield Standard** (free, automatic
L3/L4) in front of the public endpoint · **single-region CloudTrail** audit trail.

**Paid floor — DEFERRED to `balanced.tf` / `resilient.tf` (NOT in budget):** an **AWS WAF web
ACL** (managed rules + rate-based, L7, ~$8/mo) → attach with a one-line `web_acl_id` ·
**customer-managed KMS CMKs** (auditable rotation) replacing the AWS-managed keys ·
**multi-region CloudTrail** + Flow Logs (resilient). To harden, copy those resources from
`balanced.tf` — or just deploy `balanced.tf`.

> Note: a few budget resources are still NAMED `cf_waf` (e.g. `aws_acm_certificate.cf_waf`)
> because the design node is called that — there is **no WAF resource in `budget.tf`**, just
> the legacy node id. Cosmetic; rename freely.

> **If this workload ever takes regulated/sensitive data,** the paid floor becomes
> correct-required and belongs in budget too — regenerate with the data-sensitivity intake
> answer set to "Regulated", and Drafture pulls WAF + CMKs + the multi-region trail back into
> the budget tier automatically.

## 4. What you MUST do to make `budget.tf` apply-ready

This `budget.tf` is now emitted by the **deterministic Terraform emitter** (from the typed
graph, not an LLM), so the infra-wiring gaps are structurally closed: the API Gateway
`auto_deploy` stage and the CloudFront-logs S3 delivery ACL are emitted alongside the
resources that need them (at balanced+, the customer-CMK key policies ride with them too).
Reference-only still
— the remaining work the agent owns is **application code and adoption**, not infra wiring:

- **No real Lambda handlers.** The Lambdas point at placeholder zips that don't exist.
  Supply real Python handlers: `ingest` (validate the **shared-secret bearer token** from
  the `Authorization` header against Secrets Manager — TradingView cannot HMAC-sign its
  webhooks, so a passphrase/bearer token is the auth, not a signature — then idempotent
  `PutItem` to DynamoDB on alert-id and `SendMessage` to the fan-out queue), `dispatch`
  (consume the queue, HTTP POST to the existing frontend endpoint, fail to the DLQ),
  `streams`-stub (DynamoDB Streams → S3 archive for the future AI eval). **Token
  validation is handler logic — it is NOT in the `.tf`; do not ship the endpoint without
  it**, and reject mismatches before any side-effect.
- **Adopt, don't recreate, anything that already exists.** If the user already has the
  table/buckets/hosting, `terraform import` them before applying — a naive `apply` will
  attempt to *create* and either fail or replace. Read the plan for `+ create` vs
  `~ change` on resources the user mentioned.

## 5. Hard rules

1. **Never auto-`apply`.** Run `terraform plan`, read the full diff (especially any
   `- destroy` or `->` replace), surface it to the user, and let them approve.
2. **Set an AWS billing budget** before any apply.
3. Region is us-east-1 unless the user says otherwise.
4. If a resource the user depends on appears as `replace/destroy` in the plan, **stop and
   ask** — that's data-loss risk.
