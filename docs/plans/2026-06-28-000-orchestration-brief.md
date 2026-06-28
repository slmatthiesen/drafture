# Orchestration brief — four parallel streams (2026-06-28)

**For:** a fresh orchestrator instance picking up Drafture. **Base:** `main`
(`992b271`, clean, all open PRs merged/closed, branches pruned). **Goal:** run four
in-flight work streams without them stepping on each other — the recurring problem has
been concurrent edits to the same files (chiefly `App.tsx` and `cost.ts`).

## The hard rule: one worktree per stream

Every stream runs in its **own git worktree + branch** off `main`. Do not let two
agents edit a shared working tree. Setup per stream:

```
git worktree add .claude/worktrees/<name> -b <branch> main
```

Merge a stream to `main` only after its own success criteria are green, then the next
dependent stream rebases on the new `main`.

## The four streams

| Stream | What | Status | Plan | Depends on | Touches (collision surface) |
|---|---|---|---|---|---|
| **A · Router deep-links** | `react-router-dom`, `/design/:id`, extract `<DesignResult>`, `GET /api/designs/:id`. Fixes back-button-exits-site. | 🟢 READY | `2026-06-28-001-router-deep-links.md` | — | **`apps/web/src/App.tsx`** (heavy), `main.tsx`, `lib/api.ts`, new `DesignResult.tsx`, `routes/designs.ts` (+test) |
| **B · Community gallery** | `GET /api/designs` list, `/gallery` page, tag facets, voting UI. | 🟡 SPEC'D, blocked on A | `docs/phase2-gallery.md` | **A** (router + `<DesignResult>` + `GET :id`) | **`apps/web/src/App.tsx`** (heavy), new gallery components, `routes/designs.ts` |
| **C · Cost GAP 1 cheap-instance** | Add cheap-instance seed entries (t4g.nano/micro, cheap db) so Budget tier's raw body is honest (today every node prices at m5.large $70 / db.t3.medium $50); + GAP 2 matcher. | 🟡 PARTIAL | `2026-06-27-002-cost-honesty-and-self-host-hosting.md` (§Remaining cost gaps, exec step 2) | — | `apps/api/src/pipeline/cost.ts`, `packages/kb/pricing-facts.seed.json`, `test/golden/fixtures.ts`, `test/golden/properties.ts` |
| **D · Haiku launch default** | Make Claude Haiku 4.5 the default model + sync price defaults. | 🟢 DONE on branch, needs rebase+merge | branch `feat/llm-default-haiku` (`51b68d9`, 1 commit, 29 behind main); details in memory `stackdraft-next-steps` | — (user gate: "test Haiku last") | `apps/api/src/config.ts`, `llm/claude.ts`, `.env.example`, `README.md` |

## Collision matrix — who fights whom

- **A ✕ B** — both heavily rewrite `apps/web/src/App.tsx`; B consumes A's
  `<DesignResult>` and `GET /api/designs/:id`. **Serialize: A fully merges before B
  starts.** This is the one real conflict.
- **C** — backend cost engine only (`cost.ts`, seed, golden fixtures). No web overlap.
  Fully parallel with everyone.
- **D** — config/model only (`config.ts`, `claude.ts`, docs). No overlap. Already
  committed; the work is rebase + verify + merge, not new code.
- A/B vs C vs D share **zero files**.

## Recommended run order

```
t0 ─┬─ Stream A  (router)      worktree: router        ──► merge to main ──► Stream B (gallery)
    ├─ Stream C  (cost gap 1)  worktree: cost-gap1     ──► merge to main
    └─ Stream D  (haiku)       rebase feat/llm-default-haiku ► verify ► merge (on user's go)
```

- **Kick off A, C, D immediately, in parallel** — they share no files.
- **B is gated on A.** Start B only after A lands on `main`; B's first step is
  `git worktree add … -b feat/gallery main` so it picks up `<DesignResult>`.
- **D is gated on the user**, not on code — the user wants Haiku tested last. Have the
  branch rebased and verification-ready; merge on their word.

## Per-stream success criteria (loop until green)

- **A:** new `designs.test.ts` green; `App.test.tsx` behavior unchanged; manual deep-link
  + reload + back-button all correct; `vite build` green. (Full list in A's plan.)
- **B:** `GET /api/designs` returns approved-only; `/gallery` lists + tag-filters;
  card click renders at `/design/:id`; URL shareable + reload-safe; curated/generate
  flows unchanged. (Acceptance list in `phase2-gallery.md`.)
- **C:** Budget tier raw body prices a budget box (not m5.large); golden properties
  still green; no tier non-monotonicity. Add a golden fixture asserting the cheap path.
- **D:** `pnpm -C apps/api test` green after rebase; default-model assertion in
  `config.test.ts`; one cheap live sample confirms Phase-2 reasoning still holds (memory
  `stackdraft-next-steps` has the prior measured baseline — don't re-run paid jobs in a
  loop, one sample).

## Context every stream agent should load first
- `CLAUDE.md` (global) — terse/action-first, pnpm/uv, branch-before-code, push-after-green.
- This repo's memory index: `.claude/projects/.../memory/MEMORY.md` (Drafture).
- The stream's own plan doc (table above).

## Notes / gotchas
- Store is **SQLite** (better-sqlite3), not DynamoDB — designs persist in the
  `generations` table from Phase 1.
- `feat/llm-default-haiku` is 29 commits behind `main`; expect a real rebase, but the
  payload is only 5 files (see its commit `51b68d9`).
- `apps/web` test script is `vitest run` — invoke as `pnpm -C apps/web test` (do NOT
  append `run`, it becomes a no-match filter).
