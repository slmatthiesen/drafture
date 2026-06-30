# Cost/Speed Report + Launch Plan — 2026-06-29

## Part 1 — Where the credits actually go (measured, not estimated)

Pricing: Sonnet 4.6 — **$3/M input, $15/M output**, $3.75/M cache-write, $0.30/M cache-read.

### A fresh design generation ≈ $0.10–0.18 — ~97% is OUTPUT tokens

Measured (notification-system, instrumented this session):

| Component | Tokens | Cost | Share |
|---|---|---|---|
| **Output** (the 3-tier JSON design) | 10,923 | **$0.1638** | **97.6%** |
| Input (the request) | 739 | $0.0022 | 1.3% |
| Cache-read (system prompt, already cached) | 6,117 | $0.0018 | 1.1% |
| Cache-write | 0 | $0 | 0% |
| **Total** | | **$0.168** | |

Across the 5 designs measured this session, output ran **6,757–10,923 tokens** → **$0.10–0.16 of output alone**. Input + caching is already negligible (~2%); prompt caching is working. **The design's output tokens ARE the credits.**

### A Terraform pull (the new pain) ≈ $0.10–0.45 — also OUTPUT-bound, and SLOW

`/api/config` allows **32,000 output tokens** (`routes/config.ts:44`, raised from 2.5k→16k→32k so the full security-floor HCL never truncates). The cap doesn't force 32k, but a big tier genuinely emits it:

| Tier pulled | ~HCL output | Cost | Latency @ ~57 tok/s |
|---|---|---|---|
| Budget (simple) | ~6–10k tok | ~$0.10–0.15 | ~2–3 min |
| Resilient (full floor, multi-region, ~100+ resources) | ~25–30k tok | **~$0.40–0.45** | **~7–9 min** |
| Input (serialized tier) | ~2–4k tok | ~$0.01 | — |

So **a single resilient-tier Terraform pull can cost MORE and take LONGER than the entire design generation.** Cached 24h + persisted after first pull, so it's a one-time cost per (design, tier) — but the first pull is the multi-minute wait you hit.

### The unifying diagnosis

**Everything is output-token-bound.** Generation emits 7–11k tokens; Terraform up to 32k. At $15/M output and ~57 tok/s decode, **output tokens are simultaneously the dollars AND the minutes.** Input/caching is already solved. Every fix below is therefore some flavor of "emit fewer output tokens," "skip the call entirely (cache/retrieve/pre-bake)," or "use a cheaper/faster model."

Day ledger for context: 2026-06-29 = 11 calls, $1.78 (mix of generations, Terraform pulls, and the curated re-seed).

---

## Part 2 — The plan (phased, by impact-per-effort)

### Phase 0 — Merge what's done (ready now, no new build)

Three branches are green and waiting; the running app is the **pre-optimization** state until they land.

1. `chore/dogfood-selfhost-prompt` — refined self-host seed prompt + loading-copy fix.
2. PR #8 `feat/semantic-learning-network` — instant-serve + grounding + backfill. Verified live (Voyage, RPM lifted).
3. Apply the **threshold tuning** to PR #8: `SEMANTIC_GROUND_THRESHOLD 0.82 → 0.60` (real Voyage paraphrase distances are 0.60–0.85; unrelated ~0.49, so 0.60 captures related, excludes noise). Keep `RETURN 0.92` (strict — instant-serve only on near-identical, never serve a subtly-wrong design).

**Reality check on the learning network's cost impact:** it discounts prompts SIMILAR to an approved design (instant-serve = $0) and grounds adjacent ones. A genuinely **novel** prompt still pays a full generation. It compounds as the approved corpus grows — it is NOT a flat discount on every generation.

### Phase 1 — Kill the Terraform wait (highest user-visible pain)

- **1a. Pre-bake curated Terraform offline.** A script (like `backfillEmbeddings.ts`) generates + persists Terraform for the 6 curated designs so gallery visitors NEVER wait. One-time cost ≈ **18 pulls (6×3 tiers) × ~$0.20 avg ≈ $3–4** (or pre-bake only the recommended tier per design ≈ $1–1.5). After that: $0, instant, forever. **Approve the one-time spend before running.**
- **1b. Stream `/api/config` to the browser.** Today the route waits for the full HCL then returns one blob → multi-minute hang AND a Cloudflare 524 in prod. Stream it so the user sees HCL appear (progress, not hang) and bytes flow before the 100s edge timer. Medium effort.

### Phase 2 — Cut generation cost+latency at the root (the structural win)

- **2a. Tier-delta emission.** The model emits 3 FULL node+edge graphs that are ~70–80% identical. The schema already has a `delta` field. Have it emit budget's full graph once + balanced/resilient as structured add/modify/remove ops, then reconstruct full tiers deterministically before costing. Est. **~35–40% output cut → ~$0.11/gen + proportionally faster.** Largest lever; also the biggest code change (schema + prompt + reconstruction + re-seed curated). Aligns with the deterministic-over-agentic strategy.
- **2b. Trim verbosity** — cap keyDecisions ~4–5, shorter node `role`/`security`, drop derivable edges. ~15–25% more.
- **2c. Haiku option** (stacks on everything) — ~2× faster decode, ~3.5× cheaper. One knob per call site (`generate` and/or `generateConfig`). Reference HCL and the deterministic-harness-carried design quality are both within Haiku's range (tested earlier). Pairing Haiku + delta-emission → **~$0.03/gen, well under the 100s 524 line.**

### Phase 3 — Go live

- **Cloudflare 524 path** (generate AND config both blob-return today → both 524 on big outputs in prod). Pick: **(A)** ship the API path DNS-only (not Cloudflare-proxied) — zero code, keeps Sonnet, app has its own rate-limit + $5 ceiling; or **(B)** the streaming fixes from 1b/2 make both paths 524-safe behind Cloudflare. A = fastest launch, B = proper.
- Mint prod key (separate from dev), `terraform apply` the box, seed the DB on the box (`seedCurated` + `recomputeCuratedCosts` + `backfillEmbeddings`), set `VOYAGE_API_KEY`/`DAILY_SPEND_CEILING_USD`/Turnstile, smoke test.

---

## Recommended sequence

Phase 0 (merge) → **1a** (pre-bake curated TF, biggest visible win for $3–4) → Phase 3 launch via **3A** (DNS-only API, ship now) → then 1b + Phase 2 as fast-follows (streaming + the structural output cut). Haiku (2c) can be flipped on at any point as a cost/speed multiplier.
