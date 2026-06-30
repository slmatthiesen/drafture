# DRAFTURE — agent handoff brief (READ THIS FIRST)

> Source: Drafture design `qg7zz9UuLpPL` · tier: **budget** · region: us-east-1 · generated 2026-06-29
> Siblings in this pack: `budget.tf` (reference Terraform), `design.json` (full design body).

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
- **⚠ The dashboard's READ PATH is not provisioned — this is an open gap, not a decision
  to skip it.** `budget.tf` is **write-only**: DynamoDB IAM grants are `PutItem`/`UpdateItem`
  only, there is no read Lambda, and no public GET route. The user's existing static page
  has **no way to fetch trades to display.** Before finalizing, **raise this to the user**
  and add one of:
  1. a public read Lambda + API GW GET route (`GET /trades`, `GET /trades/{id}`) reading
     DynamoDB (Scan/Query), or
  2. an AppSync GraphQL endpoint over the table, or
  3. if the page is already wired to something else, confirm and stop.
  Do **not** silently leave the page unable to read, and do **not** silently bolt on a
  design without confirming the approach.
- **AI eval is async.** The webhook returns ~200ms; eval runs from the queue. Do not make
  eval synchronous with the webhook response.
- **No compliance regime.** No PII / regulated data → no HIPAA/PCI scope. Don't invent one.

## 3. Security floor (non-negotiable — preserve all of these)

TLS everywhere (terminate HTTPS at CloudFront) · KMS/SSE at rest (DynamoDB SSE, S3 SSE,
KMS-backed CloudWatch Logs) · least-privilege IAM per service, no wildcards · S3 Block
Public Access on every bucket · CloudFront + WAF (managed rules + rate-based) in front of
the public endpoint · CloudTrail audit trail. `budget.tf` already models these — keep them
when you refactor.

## 4. What you MUST do to make `budget.tf` apply-ready

This is **reference-only** HCL. Known gaps the agent owns:

- **No real Lambda handlers.** All three Lambdas point at placeholder zips
  (`lambda.zip`, `eval_lambda.zip`, `rotate_secret.zip`) that don't exist. Supply real
  Python handlers: `ingest` (verify TradingView HMAC + timestamp, idempotent
  `PutItem` to DynamoDB on alert-id, `SendMessage` to the queue), `eval` (consume from
  queue, fetch market data via the secret, run the Python analysis, write result +
  artefact), `rotate_secret` (Secrets Manager rotation). **HMAC verification is handler
  logic — it is NOT in the `.tf`; do not ship the endpoint without it.**
- **API Gateway has no stage/deployment.** `aws_apigatewayv2_route` + integration exist but
  there is no `aws_apigatewayv2_stage`/`aws_apigatewayv2_deployment`, so the endpoint won't
  actually serve. Add an `auto_deploy = true` stage.
- **CloudFront logging bucket needs a delivery policy/ACL.** `aws_s3_bucket.cloudfront_logs`
  is referenced but has no policy granting CloudFront log delivery — add the canonical
  S3 log-delivery policy.
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
