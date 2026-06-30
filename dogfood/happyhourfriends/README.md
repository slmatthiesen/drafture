# Happy Hour Friends — agent-handoff pack (Drafture)

A budget-tier AWS reference design + Terraform for the Happy Hour Friends app (SSR/ISR
Next.js + Postgres/PostGIS + a scale-to-zero headless-Chromium render service), generated
from a requirements brief through the Drafture pipeline.

## What's in here

| File | What it is |
|---|---|
| `DRAFTURE.md` | **Read first.** Architecture, intentional scope decisions, the security floor, what to fix before apply, and the open decisions to confirm (§6). |
| `budget.tf` | Reference-only Terraform for the **budget** tier (105 resources). Not apply-ready — see `DRAFTURE.md §5`. |
| `design.json` | Full Drafture design body (all 3 tiers, keyDecisions, costs, security floor). |
| `prompt.txt` · `answers.json` | The exact brief that generated this pack — re-run them to regenerate. |

## Make it live (the careful path)

1. Read `DRAFTURE.md` end to end — several omissions are deliberate; §5 lists what you own.
2. Confirm the open decisions in §6 (chiefly: keep the SQS buffer, or collapse to a
   Postgres-only queue).
3. Supply real container images (web + orchestrator) and the Chromium render Lambda; close
   the two wire-up gaps flagged in `budget.tf`.
4. `terraform plan`, set an AWS billing budget, review the diff — **never auto-apply**.

## Regenerating the pack

```
pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx \
  scripts/generateDesign.ts --prompt ../../dogfood/happyhourfriends/prompt.txt \
  --answers ../../dogfood/happyhourfriends/answers.json \
  --tier budget --out ../../dogfood/happyhourfriends
```

Use `--tier balanced` (adds ElastiCache, X-Ray, Aurora, dashboards) or `--tier resilient`
(multi-AZ, PagerDuty) for the higher tiers. Set `LLM_PROVIDER=glm LLM_MODEL=glm-4.5-flash`
for a $0 run (lower quality).
