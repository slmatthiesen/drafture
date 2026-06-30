# Happy Hour Friends — agent-handoff pack (Drafture)

A **cost-honest budget-tier** AWS reference design + Terraform for the Happy Hour Friends app
(SSR/ISR Next.js + Postgres/PostGIS + a scale-to-zero headless-Chromium render service),
generated from a requirements brief through the Drafture pipeline.

> The budget tier is a **single box** — one EC2 t4g.medium running Docker Compose (web +
> orchestrator + self-managed Postgres/PostGIS), with only the spiky render service split out
> to Lambda. Idle floor **~$25/mo (one always-on instance)**, not the ~$100+/mo managed
> ALB+Fargate+RDS+NAT stack a brief like this often gets mis-sized into. The managed split is
> the **balanced** tier's job, not the budget tier's.

## What's in here

| File | What it is |
|---|---|
| `DRAFTURE.md` | **Read first.** Architecture, intentional scope decisions, the security floor, what to fix before apply, and the open decisions to confirm (§6). |
| `budget.tf` | Reference-only Terraform for the **budget** tier (84 resources). Not apply-ready — see `DRAFTURE.md §5`. |
| `design.json` | Full Drafture design body (all 3 tiers, keyDecisions, costs, security floor). |
| `prompt.txt` · `answers.json` | The exact brief that generated this pack — re-run them to regenerate. |

## Make it live (the careful path)

1. Read `DRAFTURE.md` end to end — several omissions are deliberate; §5 lists what you own.
2. Confirm the open decisions in §6 (chiefly: are you comfortable self-managing Postgres on the
   box at budget, or do you want to start at the balanced tier's managed RDS?).
3. Supply real container images (web + orchestrator) for the box and the Chromium render Lambda;
   close the wire-up gap flagged in `budget.tf`.
4. `terraform plan`, set an AWS billing budget, review the diff — **never auto-apply**.

## Regenerating the pack

The design is one LLM call; the reference Terraform is **opt-in** (`--with-tf`) and is a large
call per tier, so leave it off unless you actually want the `.tf`:

```
pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx \
  scripts/generateDesign.ts --prompt ../../dogfood/happyhourfriends/prompt.txt \
  --answers ../../dogfood/happyhourfriends/answers.json \
  --tier budget --out ../../dogfood/happyhourfriends --with-tf
```

Drop `--with-tf` for a design-only (cheaper) run. Use `--tier balanced` (promotes to the managed
split: Fargate + RDS + ALB + NAT + ElastiCache) or `--tier resilient` (multi-AZ, cross-region DR)
for the higher tiers. Set `LLM_PROVIDER=glm LLM_MODEL=glm-4.5-flash` for a $0 run (lower quality).
