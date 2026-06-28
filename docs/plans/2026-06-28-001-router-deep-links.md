# Router + deep-linkable designs (Stream A)

**Date:** 2026-06-28 · **Status:** 🟢 READY TO BUILD · **Branch:** `feat/router-deep-links` off `main`

## Problem

There is no router. `apps/web/src/App.tsx` is a single component that switches on a
`phase` string (`idle`/`intake`/`loading`/`clarify`/`result`/`error`). Opening an
example (`openCurated`) or a saved design (`openSaved`) just flips `phase="result"`
and scrolls to top — **the URL never changes and nothing is pushed to browser
history.** Result: the back button has no in-app entry to pop, so it exits the site.
Designs are also not shareable or reload-safe.

## Goal

`/design/:id` is a real, shareable, reload-safe route. Back button returns to the
landing page instead of leaving the site. This is the structural foundation Stream B
(community gallery) builds on — it is steps 1–2 of `docs/phase2-gallery.md`, pulled
forward on its own because it independently fixes the back-button bug.

## Scope (this stream only — NOT the gallery)

### 1. Backend — `GET /api/designs/:id`
**File:** `apps/api/src/routes/designs.ts` (already has `POST /:id/vote`; its header
comment already notes this GET is deferred to Phase 2 — implement it now).
- `GET /api/designs/:id` → `ctx.stores.generations.getById(id)`.
- **404 if missing OR `status !== "approved"`** (pending/hidden never public).
- Return the stored design body shaped like the generate `result` outcome so the same
  renderer consumes it (tiers, assumptions, securityFloor, recommendedTier,
  recommendationRationale, keyDecisions, plus `prompt`/`goal`).
- Store methods already exist from Phase 1 (`getById`) — no store changes.
- **Tests:** new `apps/api/src/routes/designs.test.ts` mirroring `routes/curated.test.ts`
  — 200 on approved, 404 on missing, 404 on pending/hidden.

### 2. Frontend — extract `<DesignResult>` (no behavior change)
**New file:** `apps/web/src/components/DesignResult.tsx`.
- Move the `phase === "result"` JSX block out of `App.tsx` (TierTabs + feedback banner +
  KeyDecisions + SecurityPanel + Assumptions + ReferenceConfig) into a prop-driven
  component: `{ result, goal, selectedTier, onSelectTier, feedback? }`.
- The feedback thumbs (fresh-generation-only) stays a prop so deep-linked designs
  render without it (same rule as today's `feedbackFresh`).
- This is a pure refactor — guard it by keeping the existing `App.test.tsx` green.

### 3. Frontend — router
- Add `react-router-dom` (`pnpm -C apps/web add react-router-dom`).
- Wrap `<App>` in `<BrowserRouter>` in `apps/web/src/main.tsx`.
- Routes in `App.tsx`:
  - `/` → the existing landing + intake + curated strip + recents. A **fresh**
    generation still renders inline via `<DesignResult>` in local state (no route change
    needed mid-generation — keeps the prompt-animates-up UX intact).
  - `/design/:id` → fetch via `fetchDesign(id)` and render `<DesignResult>`.
    Unknown/pending → friendly "This design isn't available" state.
- `apps/web/src/lib/api.ts`: add `fetchDesign(id): Promise<DesignFull | null>` →
  `GET /api/designs/:id`.

### 4. Wire the existing entry points to navigate
- Curated open (`openCurated`) and history open (`openSaved`) → `navigate('/design/:id')`
  instead of flipping local `phase`. Curated examples are just designs surfaced on the
  landing page — **one route, one renderer** (do NOT introduce a separate `/example/:id`).
  - Curated currently loads via `GET /api/curated/:id`. Decide one of:
    - (preferred) surface curated through `/api/designs/:id` too if their ids are in the
      generations table, OR
    - keep curated on its own fetch but still navigate to a `/design/:id`-style URL and
      branch the loader by id-prefix. Pick whichever avoids dup data; note the choice in
      the PR.
- "← All examples" back button → `navigate('/')` (or `navigate(-1)`), so it and the
  browser back button behave identically.

## Verify (success criteria)
- `pnpm -C apps/api test` green incl. new `designs.test.ts`.
- `pnpm -C apps/web test` green (App.test.tsx unchanged-behavior, new DesignResult test).
- Manual: open an example → URL becomes `/design/:id`; reload → same design renders;
  browser back → returns to landing, does NOT leave the site; share the URL in a new tab
  → renders.
- `pnpm -C apps/web build` (tsc -b + vite) green.

## Out of scope (Stream B owns these)
`GET /api/designs` list, `/gallery` route, gallery cards, tag facets, voting UI.

## Collision note
Heavy edits to `App.tsx` + new `DesignResult.tsx`. **Stream B (gallery) also rewrites
App.tsx and consumes DesignResult — B must start only after this merges to `main`.**
See `2026-06-28-000-orchestration-brief.md`.
