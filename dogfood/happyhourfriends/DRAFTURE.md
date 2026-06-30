# DRAFTURE — Happy Hour Friends, agent handoff brief (READ THIS FIRST)

> Source: generated from this pack's `prompt.txt` + `answers.json` through the Drafture
> pipeline (model claude-sonnet-4-6) · tier: **budget** · region: us-east-1 · 2026-06-30
> Siblings: `budget.tf` (reference Terraform, 84 resources), `design.json` (all 3 tiers).

This is an **agent-ready build plan**, not a finished stack. Drafture did the judgment-heavy
first 80% (architecture, sizing, security floor, cost). Your job is the last 20%: turn
`budget.tf` into something that `terraform plan`s cleanly and fits the real repo. **Read
every section — several omissions are intentional, and §6 lists open decisions to confirm.**

---

## 1. What you asked for (condensed)

SSR/ISR Next.js (Node, containerized) web app · public read-heavy pages + gated `/admin` ·
a background AI pipeline decoupled from the request path · a memory-heavy headless-Chromium
**render service** that must be scale-to-zero/pay-per-invocation · **Postgres + PostGIS**
(geospatial is load-bearing) · S3 + CDN for user photos · nightly backup + reconciliation
crons. **Cost-optimized, single-AZ OK, single US region, very low traffic today, growing
toward ~1000 cities (cached content + pipeline throughput, not concurrent dynamic traffic).**
You already run the whole thing on a single 2 vCPU / 4 GB host.

## 2. The architecture (budget tier)

```
client → CloudFront(+WAF) ─┬─ cache miss → S3  (ISR assets, media)
                           └─ dynamic    → EC2 t4g.medium  [Docker Compose, public subnet]
                                             ├ Next.js web  (SSR/ISR, in-process cache)
                                             ├ orchestrator (pg-boss, Postgres-backed queue)
                                             └ Postgres + PostGIS (localhost-bound, EBS gp3)
EC2 → Lambda "render" (headless Chromium, scale-to-zero) → S3 (>6 MB out) → presigned URL
EventBridge Scheduler → Lambda (nightly pg_dump → S3 Glacier IR · reconciliation cron)
CloudWatch Logs/Alarms → SNS (ops alert) · X-Ray traces · CloudTrail audit · Secrets Manager
```

It nails the hard parts of the brief — and, crucially, **does not over-build**:

- **Single box, not a managed split — the cost-honest call.** Web + orchestrator +
  Postgres/PostGIS are co-located in **Docker Compose on ONE EC2 `t4g.medium`** (matches your
  current single-host footprint). **No ALB, no Fargate, no RDS, no NAT gateway.** Idle floor
  **~$25/mo (the instance)** — versus the ~$100+/mo the managed ALB+Fargate+RDS+NAT quartet
  bills at *zero* traffic. The brief's "containerized / managed Postgres / scale independently"
  language describes the end-state, not a budget mandate.
- **The render service IS split out — the one place serverless wins.** Headless Chromium is
  spiky, memory-heavy, and idle most of the time, so it's a **Lambda (2048 MB, arm64)**:
  scale-to-zero, pay-per-invocation. Outputs >6 MB are written to **S3 and returned by a
  presigned URL**, exactly as the brief requires.
- **Self-managed Postgres + PostGIS on the box.** PostGIS is just an extension on *any*
  Postgres — it does **not** require RDS. The DB is **localhost-bound** (not network-exposed),
  on a KMS-encrypted EBS volume, with **nightly `pg_dump` → S3**. Managed RDS/Aurora is the
  *balanced* tier's step-up, not a budget cost.
- **Postgres-backed job queue (pg-boss).** Postgres is already on the box, so the orchestrator
  uses it as the queue — **no separate SQS at budget**. SQS + EventBridge fan-out enter at
  resilient.
- **"Scale independently" is honored as a PATH, not a cost.** Your "orchestrator should scale
  independently of web" becomes the **balanced** tier's split (Fargate web + Fargate
  orchestrator + managed RDS + ALB + NAT + ElastiCache) — built when traffic/throughput
  justifies it, not pre-paid at budget.

## 3. Intentional scope decisions — DO NOT silently undo

- **Single box, single-AZ, public subnet, no NAT, no ALB, no ElastiCache, no read replica.**
  Deliberate cost calls for very-low traffic. NAT exists only for *private*-subnet egress; a
  public-subnet box with a tight SG needs none. An ALB load-balances *multiple* targets; one
  box doesn't need one.
- **CloudFront in front of the box; ISR cache is in-process** on the Node container. No shared
  ISR store at budget — CloudFront absorbs the read burst; S3 is the revalidation write-through.
- **Postgres self-managed on the box (localhost-bound).** Managed RDS is balanced+, not here.
- **`/admin` is the same web service**, gated in-app — not a separate stack.
- **No multi-region, no premium HA tier.** You asked for cost-first; this is it.

## 4. Security floor (preserve all of these)

TLS at CloudFront · **Postgres localhost-bound (not internet-exposed)** on a KMS-encrypted EBS
volume; box in a public subnet behind a restrictive SG (443/80 from CloudFront only, **no
public DB port**), IMDSv2 enforced, **SSM Session Manager (no SSH)** · S3 Block Public Access
on every bucket · least-privilege IAM per service · WAF (managed + rate rules) at the edge ·
CloudTrail (multi-region) · KMS-encrypted CloudWatch Logs · Secrets Manager for the DB
credential. `budget.tf` models these — keep them when you refactor.

> **Why no private subnet + NAT?** A DB *process* on the app box, bound to localhost, is already
> off the public internet — it satisfies the "no public data tier" baseline **without** a
> private subnet or NAT gateway. That topology is for a *separate, VPC-bound managed* store
> (RDS/ElastiCache), which is the balanced tier's job. Not having it here is cost-honesty, not
> a floor violation.

## 5. What you MUST do to make `budget.tf` apply-ready

This is **reference-only** HCL. Known gaps the agent owns:

- **Placeholder container images + Lambda package.** The box expects a Docker Compose stack
  (real Next.js web + orchestrator images) and the render Lambda a placeholder zip/layer. Supply
  the real images (e.g. `@sparticuz/chromium` for the Lambda) and bootstrap Compose on the
  instance via user-data or SSM.
- **⚠ Wire-up gaps flagged in the file** (`terraform plan` stays green on each — fix before apply):
  - `kms-key-policy` — the KMS-encrypted CloudWatch Logs group needs `logs.<region>.amazonaws.com`
    granted `kms:Decrypt`/`GenerateDataKey*` in the CMK key policy, or PutLogEvents fails at runtime.
  - `cloudfront-origin-tls` — CloudFront → the EC2 **public DNS** has no trusted CA cert
    (`*.compute-1.amazonaws.com`) and that DNS churns on replacement. Put a **domain + ACM cert
    on an Elastic IP** in front of the box (or a small ALB+ACM, or Cloudflare) as the origin.
  - `s3-access-log-delivery` — the access-log bucket has no log-delivery grant; with Block Public
    Access, logging silently no-ops. Add the canonical delivery policy.
- **Idempotent job consumption.** The pg-boss queue is at-least-once — the orchestrator's
  consumer MUST dedupe (idempotency key per job) so a redelivery doesn't double-run a pipeline.
  This is handler logic, not in the `.tf`.
- **Migrations + PostGIS enable.** `CREATE EXTENSION postgis` on the box's Postgres and run your
  versioned migrations as a deploy step — neither is Terraform's job.
- **Backups are `pg_dump` → S3, not RDS snapshots.** The nightly Lambda dumps the box's Postgres
  to S3 (Glacier IR). This is your DR at budget — **RPO ≈ the last nightly dump**; rehearse the
  restore before you depend on it.
- **Adopt, don't recreate.** If anything already exists (the box, buckets), `terraform import`
  before applying — a naive `apply` will try to *create* and fail or replace.

## 6. Open decisions to confirm (Drafture's review notes)

- **Self-manage Postgres on the box, or start at the balanced managed RDS?** Budget self-manages
  Postgres + PostGIS on the EC2 box — cheapest, and you already run a box. If you'd rather not own
  Postgres ops (patching, backup/restore, single-AZ DR), **start at the balanced tier** (managed
  RDS + the Fargate split). The box is the right cost-first call; the trade is operational burden
  and a nightly-`pg_dump` RPO. **Decide before you build the deploy automation.**
- **The queue is pg-boss (Postgres-backed), single concept.** Unlike a prior version of this pack,
  the budget tier does **not** also stand up an SQS buffer — pg-boss on the existing Postgres is
  the single queue. SQS/EventBridge fan-out is deferred to resilient. Confirm that's the write
  path you want.
- **Gate note (honest):** the design passes **12/13** structural checks. The one miss is a
  **resilient-tier** nit — a second multi-AZ NAT gateway node left unwired in the graph. It does
  **not** affect the budget tier you're building here. (The earlier `computeMatchesDecision`
  false-positive on this hybrid box+Lambda shape is now **fixed upstream** — the check is
  per-service scoped, so a "render = Lambda" decision no longer flags the box's compute.)

## 7. Hard rules

1. **Never auto-`apply`.** Run `terraform plan`, read the full diff (any `- destroy`/`->`
   replace), surface it, and let a human approve.
2. **Set an AWS billing budget** before any apply.
3. Region is us-east-1 unless you say otherwise.
4. If a resource you depend on shows as `replace/destroy` in the plan, **stop and ask** — at
   budget that means the **EC2 instance or its EBS volume**, which *is* your database (and any
   RDS that appears once you move to the balanced tier).
