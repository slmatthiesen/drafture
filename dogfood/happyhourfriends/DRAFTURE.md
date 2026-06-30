# DRAFTURE — Happy Hour Friends, agent handoff brief (READ THIS FIRST)

> Source: generated from this pack's `prompt.txt` + `answers.json` through the Drafture
> pipeline (model claude-sonnet-4-6) · tier: **budget** · region: us-east-1 · 2026-06-29
> Siblings: `budget.tf` (reference Terraform, 105 resources), `design.json` (all 3 tiers).

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

## 2. The architecture (budget tier)

```
client → CloudFront(+WAF) → ALB → Fargate "web" (Next.js SSR/ISR) → RDS PostgreSQL/PostGIS
                                         │                          ↘ S3 (media, CDN-fronted)
                                         └→ SQS → Fargate "orch" (pg-boss) → Lambda "render"
                                                        │  (headless Chromium)  ↘ S3 (>6MB out)
                                                        └→ RDS (job state)      → pre-signed URL
EventBridge Scheduler → orch (nightly backup + reconciliation crons)
CloudWatch Logs/Alarms → SNS (ops email) · CloudTrail audit · Secrets Manager · 1 NAT gateway
```

It nails the hard parts of the brief:
- **Hybrid compute, correctly split** — web + orchestrator are **Fargate** (persistent Node
  for ISR in-process cache; Lambda's stateless cold-start breaks ISR consistency), while the
  spiky render service is **Lambda** (scale-to-zero = $0 idle, the only model that fits the
  pay-per-invocation requirement). Three separate, coherent compute decisions.
- **The 6 MB render limit** — render Lambda writes large HTML/screenshots to **S3 and returns
  a pre-signed URL** by reference, exactly as the brief requires.
- **PostGIS cost-honesty** — **RDS for PostgreSQL `db.t4g.micro` single-AZ (~$13/mo)** at
  budget, beating Aurora Serverless v2's minimum-ACU floor at near-zero traffic; Aurora is
  reserved for balanced/resilient.
- **NAT honesty** — private-subnet RDS forces exactly **one** always-on NAT gateway; this is
  called out as the unavoidable baseline cost, not hidden.

## 3. Intentional scope decisions — DO NOT silently undo

- **Single-AZ, single NAT, no ElastiCache, no read replica at budget.** These are deliberate
  cost calls for very-low traffic. ElastiCache enters at *balanced*, not here.
- **CloudFront in front of ALB; ISR cache is in-process on the Fargate task.** No shared ISR
  store at budget — CloudFront absorbs the read burst.
- **`/admin` is the same web service**, gated in-app — not a separate stack.
- **No multi-region, no premium HA tier.** You asked for cost-first; this is it.

## 4. Security floor (preserve all of these)

TLS at CloudFront · RDS in a private subnet, SSE at rest (KMS) · S3 Block Public Access on
every bucket · least-privilege IAM per service · WAF (managed + rate rules) at the edge ·
CloudTrail (mgmt + data events) · KMS-encrypted CloudWatch Logs · Secrets Manager for the DB
credential. `budget.tf` models these — keep them when you refactor.

## 5. What you MUST do to make `budget.tf` apply-ready

This is **reference-only** HCL. Known gaps the agent owns:

- **Placeholder container images + Lambda package.** The Fargate task defs point at a
  placeholder image and the render Lambda at a placeholder zip/layer. Supply the real Next.js
  image (ECR), the orchestrator image, and the Chromium Lambda (e.g. `@sparticuz/chromium`
  layer). Build/push to the ECR repo before apply.
- **⚠ Wire-up gaps flagged in the file** (`terraform plan` stays green on each — fix before apply):
  - `kms-key-policy` — the KMS-encrypted CloudWatch Logs group needs `logs.<region>.amazonaws.com`
    granted `kms:Decrypt`/`GenerateDataKey*` in the CMK key policy, or PutLogEvents fails at runtime.
  - `s3-access-log-delivery` — the access-log bucket has no log-delivery grant; with Block
    Public Access, logging silently no-ops. Add the canonical delivery policy.
- **Idempotent job consumption.** The SQS `job_queue` is at-least-once with a DLQ — the
  orchestrator's consumer MUST dedupe (idempotency key per job) so a redelivery doesn't
  double-run a pipeline. This is handler logic, not in the `.tf`.
- **Migrations + PostGIS enable.** PostGIS must be `CREATE EXTENSION`-ed and your versioned
  migrations run as a deploy step — neither is Terraform's job.
- **Adopt, don't recreate.** If anything already exists (the DB, buckets), `terraform import`
  before applying — a naive `apply` will try to *create* and fail or replace.

## 6. Open decisions to confirm (Drafture's review notes)

- **SQS vs. Postgres-only queue.** You specified a *Postgres-backed job queue* (pg-boss). The
  design ALSO put an **SQS queue between the web tier and the orchestrator** for at-least-once
  buffering. That's defensible, but it means two queue concepts. The leaner, cost-first
  alternative (listed in the design's own keyDecisions) is **web → Postgres job table
  directly**, letting pg-boss be the single queue. **Decide which you want** before building
  the consumer — it changes the web tier's write path.
- **Assumption prose nit.** One assumption line mentions "Aurora Serverless v2 … for budget";
  the keyDecision and the actual budget **node are RDS `db.t4g.micro`**. The node is
  authoritative — budget runs RDS for PostgreSQL, not Aurora.
- **Two gate checks flagged this design; both are explainable, not blockers:**
  - `computeMatchesDecision` — a **false positive** on your hybrid: it reads the "render =
    Lambda" decision as the whole tier's compute and flags the Fargate web/orchestrator nodes.
    The design is coherent (three distinct compute decisions). No action.
  - `queuesAreResilient` — the SQS queue has a DLQ but the design didn't *say* "idempotent
    consumption"; that's the real handler requirement in §5, not a structural fault.

## 7. Hard rules

1. **Never auto-`apply`.** Run `terraform plan`, read the full diff (any `- destroy`/`->`
   replace), surface it, and let a human approve.
2. **Set an AWS billing budget** before any apply.
3. Region is us-east-1 unless you say otherwise.
4. If a resource you depend on shows as `replace/destroy` in the plan, **stop and ask** —
   that's data-loss risk (especially the RDS instance).
