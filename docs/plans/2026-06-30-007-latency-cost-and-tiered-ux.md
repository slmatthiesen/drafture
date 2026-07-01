# Latency, cost, and per-tier UX (generate + Terraform)

**Status:** plan / next-session work (2026-06-30). **Owner motivation:** a "simple" prompt
cost ~$0.29 and took ~120s to generate; the Terraform panel took another minute+. This is
too rough for an end user. Root cause and fixes below; all measured, not guessed.

## 0. Root cause (one thing, three faces)

Everything painful is **a synchronous LLM call with no streaming = 60–120s + real $**. We hit
that path in three places, and every fix below is about getting OFF it (deterministic emission,
corpus instant-serve, or generating less).

## 1. Where the output tokens actually go (measured)

- **`effort` is INERT** in `llm/claude.ts` (forced tool-use has no thinking knob) → **no hidden
  reasoning tokens**. Not the cause.
- **`costDrivers` + `securityFloor` are server-added** (`cost.ts` / `generate.ts`) → they bulk the
  stored JSON but cost zero model output.
- **Generate output = the design graph.** On a sample design, `tiers` is ~84% of the stored body;
  the model's share is `baseTier` + 2 `tierDeltas` + `keyDecisions` + `assumptions`. It grew
  (~19¢→~29¢) because the prompt now MANDATES more structure on every tier: first-class
  observability (CloudWatch Logs + alarms + **SNS → on-call** as explicit nodes/edges), notification
  paths, queues with **DLQ + idempotent-consumer**, and `keyDecisions` each carrying an
  `alternativesConsidered` array. Plus 4–5 security tags per node. More mandated nodes/edges = more tokens.
- **Terraform = a separate, LARGER output event.** The deterministic emitter is **all-or-nothing per
  tier**: one node outside the ~24-service vocab (`serviceKey.ts`) sends the WHOLE tier to the LLM
  `generateConfig` at up to **32k output tokens** (`CONFIG_MAX_OUTPUT_TOKENS`). That is the minute+ AND
  likely most of the $0.29 if the TF panel was opened. Known vocab gaps: **Cognito, SES, Step Functions,
  Kinesis, OpenSearch, Aurora-serverless** (a login → Cognito → fallback).

## 2. Fixes, ranked (cheapest × highest-impact first)

### A. Lazy per-tier generation — budget first, add others on demand  *(the cost+latency lever)*
Today every request generates all three tiers. Change: the user picks a tier up front (**budget by
default**); we generate **only that tier** (~⅓ the graph output → ~$0.10, ~40s). From the result screen
the user can **"add" balanced or resilient**, which generates that one tier on demand and can run in the
**background while they stay on the current tier**. Cached after first generation (per-tier response
cache + the generation row).
- Requires a per-tier generate path (generate ONE tier as a full graph, not base+deltas) OR: generate
  budget as base, and "add tier" = generate just that delta. Prefer the delta path (smaller add-on output).
- Consequence: the base+delta reconstruction already exists; reuse it so "add balanced" emits only the delta.

### B. Widen the deterministic emitter vocabulary  *(kills the TF minute+ AND the cost spike)*
Add ~20–30-line emitters (modeled on the existing `emitters/*`) for the common fallback services:
**Cognito, SES, Step Functions, Kinesis, OpenSearch** (+ Aurora-serverless if distinct from `rds`).
Each registered service turns a minute+ LLM HCL call into instant $0 deterministic emission. **Rides the
TF-regen session** (same subsystem: `pipeline/terraform/`). This is the #1 win for TF pain.

### C. Partial fallback, not all-or-nothing  *(defense-in-depth for TF)*
Emit the supported nodes deterministically and LLM ONLY the unsupported node's snippet, so one exotic
node stops nuking the whole tier to a 32k-token call. Bounds worst-case even when coverage is incomplete.

### D. Perceived latency + real instant-serve  *(for the residual generate wait)*
- **SSE progress:** convert `/api/generate` to Server-Sent Events emitting real phase events + a live
  token heartbeat off the provider's EXISTING internal stream (`claude.ts` already uses
  `messages.stream().finalMessage()` for ≥16k). `LoadingDraft` shows honest progress + a "drafting… N
  tokens" ticker instead of a fake time-based rotation. Do NOT attempt token-streaming-to-render — the
  base+deltas + server-side-cost shape fights it (partial JSON isn't renderable).
- **Grow the corpus → instant-serve:** a simple prompt at 120s MISSED the learning-network instant-serve
  (corpus=16, cosine ≥ 0.80 returns in ~1s $0). Growing the corpus so common shapes short-circuit is the
  real speedup for common prompts (mechanism already built).

### E. Warm-emit TF at persist time  *(optional)*
When a generation is persisted, background-emit deterministic TF for its tiers so the panel opens
instantly. Only helps once B widens coverage.

## 3. Per-tier picker UX (the "buttons") 

- **Where:** on the plan-making/intake screen and on the result header. Three buttons —
  **Budget / Balanced / Resilient — Budget default.**
- **Under each button:** the expected traffic band + what goes in that bucket (robustness shape). Proposal,
  tied to the existing scale ladder (`stackdraft-tier-scale-ladder`):
  - **Budget** — *~<1k req/day* — single-AZ, one box or serverless-no-VPC, ~$ idle. Free security floor.
  - **Balanced** — *~10k req/day* — multi-AZ, managed split (ALB/Fargate/RDS), WAF + customer-CMK + Secrets Manager.
  - **Resilient** — *~100k+ req/day* — multi-region/DR, read replicas, multi-region CloudTrail + Flow Logs.
- **After generation:** an **"+ Add tier"** affordance (see fix A) generates another bucket on demand,
  background, without leaving the current view.
- **The "4th button" (OPEN — decide during build):** candidates — (a) "Recommend for me" (auto-pick a tier
  from the brief), or (b) it's not a 4th button but the "+ Add tier" affordance. Recommend (b) + optional (a).
- **Tension to hold (surface, don't bury):** the current model is "**traffic is its own axis, tiers are
  robustness**" (single-AZ→multi-AZ→multi-region at the SAME traffic). The per-button traffic labels
  re-associate a *suggested* band per tier as GUIDANCE, not a hard re-coupling. Keep the labels as
  "typically chosen for ~X" guidance so we don't regress the decoupling that the cost model depends on.

## 4. Sequencing

1. **TF-regen session** (already queued): while regenerating the self-host design, land **B** (emitter
   vocab) — same subsystem, biggest TF win. Optionally **C**.
2. **Generate latency + UX workstream:** **A** (lazy per-tier + budget default + tier picker) → **D**
   (SSE progress) → corpus growth. **E** last.

## 5. Out of scope
- Token-streaming-to-render (fix D explicitly rejects it for this output shape).
- Re-coupling traffic to tier in the cost model (keep the axes separate; labels are guidance only).
