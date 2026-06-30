# Trade-monitoring handoff pack (Drafture dogfood)

This is the **agent-handoff pack** proof-of-concept — a TradingView trade ingest + AI-eval
design (budget tier), regenerated through the improved Drafture pipeline.

## What's in here

| File | What it is |
|---|---|
| `DRAFTURE.md` | **Agent brief — read first.** The architecture, the intentional scope decisions (incl. the frontend ingest-contract gap), the security floor, and the gaps the agent must close. |
| `budget.tf` | Reference-only Terraform for the budget tier (Sonnet, gate PASS 13/13). |
| `design.json` | The full Drafture design body (all 3 tiers, keyDecisions, security floor) — machine-readable reference. |
| `prompt.txt` · `answers.json` | The exact intake that generated this pack — re-run them to regenerate. |

## The thesis being tested

Drafture ships **judgment, not just diagrams.** For that judgment to survive into the
build, the agent that finishes the work needs Drafture's *decisions and scope boundaries*
— not only the raw `.tf`. Otherwise the same scoping bug propagates: an agent handed only
`budget.tf` can't tell that the missing dashboard read-path is an **open gap to raise**,
not a feature to skip or silently reinvent.

`DRAFTURE.md §2` is the load-bearing piece: it tells the agent what's deliberately out of
scope vs. what's an unresolved gap to flag.

## How to run the dogfood

1. Point a coding agent (Claude Code) at this directory.
2. Prompt: *"Read DRAFTURE.md first, then review budget.tf against it. Tell me what you'd
   change to make it plan-ready, and surface anything DRAFTURE.md flags as an open gap."*
3. The pass/fail signal: does the agent **raise the frontend ingest-contract gap on its own**
   (citing §2 — confirm the existing frontend can receive the pushed signals), and does it
   **stop at `terraform plan`** rather than auto-applying? If yes, the handoff thesis holds.

## Regenerating the pack

`design.json` + `budget.tf` are produced from `prompt.txt` + `answers.json` by the offline
generator, which drives the same pipeline as `/api/generate` + `/api/config` (grounding →
generate → cost → security floor → completeness gate → TF wire-up validator):

```
pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx \
  scripts/generateDesign.ts --prompt ../../dogfood/trade-monitoring-handoff/prompt.txt \
  --answers ../../dogfood/trade-monitoring-handoff/answers.json \
  --tier budget --out ../../dogfood/trade-monitoring-handoff
```

Set `LLM_PROVIDER=glm LLM_MODEL=glm-4.5-flash` for a $0 run (lower quality; may not pass the
gate). The production UI path (`/api/config`) generates + caches the `.tf` on the generation row.
