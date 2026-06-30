# DRAFTURE — Happy Hour Friends, agent handoff brief (READ THIS FIRST)

> Source: `design.json` generated from this pack's `prompt.txt` + `answers.json` (model
> claude-sonnet-4-6); the `*.tf` are emitted **deterministically** from that graph · tier
> focus: **budget** · region: us-east-1 · 2026-06-30
> Siblings: `budget.tf` (82 resources), `balanced.tf` (109), `resilient.tf` (127) — reference
> Terraform for all three tiers · `design.json` (the full typed graph).

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
  current single-host footprint). **No ALB, no Fargate, no RDS, no NAT gateway.** The
  **compute idle floor is ~$25/mo (the instance)** — versus the ~$100+/mo the managed
  ALB+Fargate+RDS+NAT quartet bills at *zero* traffic. The brief's "containerized / managed
  Postgres / scale independently" language describes the end-state, not a budget mandate.
  - **Honest all-in baseline (read this):** the box is ~$25, but the **always-on security
    floor adds ~$15–25/mo** — WAF web ACL (~$5 + ~$1/rule), **3 KMS CMKs** (~$3), multi-region
    CloudTrail + CloudWatch Logs ingestion/retention, plus ~70 GB gp3 EBS (~$6) and S3/egress.
    Realistically **~$45–65/mo all-in at idle** (list-price estimate), not $25 — still well
    under the managed quartet, but materially above a bare DO droplet. If you want to trim it,
    §6 lists which security-floor items are safe to drop at this scale.
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

This is **reference-only** HCL. **The emitter now closes the wire-up gaps a prior LLM draft
left** — `detectWireupGaps()` returns **zero** and the file is `terraform validate`-clean:
- `kms-key-policy` — the CloudWatch Logs CMK is emitted **with** the `logs.<region>.amazonaws.com`
  grant baked into its key policy (keyed off the literal region). Done.
- `cloudfront-origin-tls` — CloudFront no longer points at a churning EC2 public DNS. The dynamic
  origin is now a **required `variable "origin_domain"`** (https-only): you supply a real
  domain+cert for the box. It's an explicit input you MUST set, **not a silent failure**.
- `s3-access-log-delivery` — the CloudFront-logs bucket is emitted with the canonical
  log-delivery ACL grant. Done.

**But "valid HCL" ≠ "a running app." The agent still owns the last 20% — this file builds the
house, not the tenant:**

- **The EC2 box boots BARE.** No `user_data`, no Docker/Compose, no app pull/build, no systemd
  unit, no Postgres/PostGIS install, no reverse proxy. **Nothing deploys your app yet.** Add a
  `user_data` (or SSM doc) that installs Docker + Compose, pulls your Next.js web + orchestrator
  images, installs/enables **PG17 + PostGIS**, and starts everything. This is the single biggest
  gap — the rest is config.
- **Placeholder Lambda packages (render / backup / cron).** All three `*_placeholder.zip` are
  empty. The **render** one is the hard one: headless Chromium needs a **container image or a
  `@sparticuz/chromium` layer**, not an empty zip. backup/cron need their real handlers (the
  backup Lambda assumes `pg_dump` reachable over SSM port-forward to the box).
- **`origin_domain` needs a cert someone provisions.** CloudFront talks **https-only** to
  `var.origin_domain`, but nothing here issues that cert. Run **Caddy (Let's Encrypt) on the box**
  bound to that hostname, or front the box with **ALB + ACM**. Until then the origin is undefined.
- **Postgres + PostGIS migration off the droplet.** Self-managed means install PG17 + PostGIS on
  the box, then import prod data from DO (`pg_dump`/restore). `CREATE EXTENSION postgis;` + your
  versioned migrations run as a deploy step — not Terraform's job.
- **Required variables with no defaults — set every one:** `ami_id`, `domain_name`,
  `route53_zone_id`, `origin_domain`, `ops_email`. **Route53 must already be authoritative for the
  domain** (it currently points at DO — cutover is a DNS move).
- **Secrets + state + access:** `aws_secretsmanager_secret_version` ships `REPLACE_ME` —
  inject the real DB credential out-of-band (never commit it). There's **no backend/state config**
  (add S3+DynamoDB remote state before a team applies) and **SSM-only access (no SSH key)** by
  design — confirm you have Session Manager set up before you need to get in.
- **Idempotent job consumption.** The pg-boss queue is at-least-once — the orchestrator's
  consumer MUST dedupe (idempotency key per job) so a redelivery doesn't double-run a pipeline.
  Handler logic, not in the `.tf`.
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
- **Gate note (honest):** the design now passes **13/13** structural checks and the cost-honest
  budget check (idle floor $24.53, EC2 only). The prior 12/13 (a multi-AZ NAT node read as an
  unwired orphan) and the `computeMatchesDecision` false-positive on this hybrid box+Lambda shape
  are both **fixed upstream** (NAT/WAF/Shield are now orphan-exempt; the compute check is
  per-service scoped, so "render = Lambda" no longer flags the box).
- **Trimming the security-floor overhead (the ~$15–25/mo from §2).** The gate's idle floor counts
  only always-on *compute/db*, so WAF + KMS + CloudTrail don't show up there — but they're real
  fixed cost. At "very low traffic, single box" you can defensibly drop some:
  - **Multi-region CloudTrail → single-region.** A one-box, one-region app doesn't need a
    multi-region trail; the budget `aws_cloudtrail` hard-codes `is_multi_region_trail = true`.
    Single-region management events are the cheaper floor. *(This is the one item that's arguably
    an emitter default worth changing for budget — flagged for the generator, not just this pack.)*
  - **3 KMS CMKs → fewer.** Separate CMKs (main/cw-logs/sns) are clean isolation but $1/mo each;
    consolidating to one CMK is fine at this scale if you'd rather save the ~$2/mo.
  - **WAF** is the one to KEEP — it's your edge protection baseline and the cheapest real defense
    on a single public box. Don't drop it to save $8.

## 7. Hard rules

1. **Never auto-`apply`.** Run `terraform plan`, read the full diff (any `- destroy`/`->`
   replace), surface it, and let a human approve.
2. **Set an AWS billing budget** before any apply.
3. Region is us-east-1 unless you say otherwise.
4. If a resource you depend on shows as `replace/destroy` in the plan, **stop and ask** — at
   budget that means the **EC2 instance or its EBS volume**, which *is* your database (and any
   RDS that appears once you move to the balanced tier).
