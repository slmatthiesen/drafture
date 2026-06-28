# Phase 2 — Public Gallery (build spec)

> **Status:** spec'd, not built. Builds on **Phase 1** (`generations` persistence, PR #5).
> **Sequence:** merge PR #5 to `main` first (reconcile `routes/generate.ts` + `scripts/seedCurated.ts` with the other agent's overlapping edits), then branch Phase 2 off `main`.

## Goal

A browsable gallery of **operator-approved** generations: list with tag facets → click → view the full architecture (reusing the existing result renderer) → pull Terraform. Plus deep-linkable designs and wiring the Phase 1 `id` into Terraform pulls so they persist for free.

## Decisions (locked)

- **Separate galleries.** Keep the curated strip as a "Featured" teaser on the landing page; add a distinct Community gallery for approved user designs. Two stores stay separate (no union query); unify later only if community volume justifies it.
- **`react-router-dom`.** Real routes (`/`, `/gallery`, `/design/:id`), not query-param hacks. Wrap `<App>` in `<BrowserRouter>`. The intake sub-states (idle/loading/clarify/result/error) stay local to the landing route; router owns top-level pages.
- **Client-side tag filtering v1.** Fetch approved (cap ~200) once, filter by tag chips in the browser. Move filtering/pagination server-side only when volume demands.
- **No share link on the generate-result screen in v1.** A link to an unapproved design 404s (submitter can't approve their own); sharing belongs in the gallery where designs are already public.

## In scope

- `GET /api/designs` (list approved) + `GET /api/designs/:id` (detail, approved-only).
- Extract `<DesignResult>` from `App.tsx` (reused for gallery detail + fresh result).
- `<GalleryView>` + tag-facet chips.
- `react-router-dom` routes + deep-linkable `/design/:id`.
- Thread `generationId` into `/api/config` (activates Phase 1 lazy Terraform persist).

## Out of scope (Phase 3+)

Full-text search (FTS5), pagination/infinite-scroll, user accounts / "my designs" / ownership, template extraction, domain tags, merging curated + community into one store.

## Backend (small — ~2 handlers, no store changes)

**File: `apps/api/src/routes/designs.ts`** (add to the file that already has `POST /api/designs/:id/vote`)

- `GET /api/designs` → `{ designs: ctx.stores.generations.listApproved(200) }`. Unguarded beyond the access gate (cheap DB read, no spend — same pattern as `/api/curated`).
- `GET /api/designs/:id` → `getById(id)`; **404 if missing or `status !== "approved"`** (pending/hidden never public). Return:
  ```ts
  { id, description, tags, recommendedTier, model, upvotes, downvotes, genCount, createdAt,
    design: JSON.parse(body) }   // design is a GenerateResponse → renders via the same path
  ```
- No store changes — Phase 1's `listApproved(limit)` and `getById(id)` already cover both. Add route tests mirroring `routes/curated.test.ts`.

## Frontend

1. **Extract `<DesignResult>`** — `apps/web/src/components/DesignResult.tsx` (new)
   - Lift `App.tsx` ~L396–469 (back button, feedback strip, TierTabs, KeyDecisions, SecurityPanel, assumptions, ReferenceConfig) into a component: `{ result: GenerateResponse; designId?: string; feedbackFresh: boolean }` + callbacks.
   - All entry points (fresh generate, curated open, history open, **gallery open**) route through it.

2. **Routing** — add `react-router-dom`; wrap in `<BrowserRouter>` (`main.tsx`); define routes in `App.tsx`:
   - `/` → landing (intake form + curated Featured strip + "Browse gallery" link). Fresh-generation result renders inline via `<DesignResult>` (local state, not a route).
   - `/gallery` → `<GalleryView>`.
   - `/design/:id` → fetch + render `<DesignResult>` (deep-linkable). Pending/unknown → friendly "not available" state.

3. **API client** — `apps/web/src/lib/api.ts` (mirror `fetchCurated*`)
   - `fetchDesigns(): Promise<DesignSummary[]>` → `GET /api/designs`
   - `fetchDesign(id): Promise<DesignFull | null>` → `GET /api/designs/:id`
   - `fetchConfig(tier, generationId?)` → add optional `generationId` to the `/api/config` body (server accepts it from Phase 1).

4. **Types** — `apps/web/src/lib/types.ts`
   - Add `id?: string` to `GenerateResponse` (Phase 1 now returns it).
   - Add `DesignSummary` (id, description, recommendedTier, tags[], upvotes, downvotes, genCount, model, createdAt) and `DesignFull` (extends summary with `design: GenerateResponse`).

5. **`<GalleryView>`** — `apps/web/src/components/GalleryView.tsx` (new, modeled on `CuratedGallery.tsx`)
   - Fetch `fetchDesigns()`; render cards (description, recommendedTier, tag chips, vote column → `POST /api/designs/:id/vote`).
   - Tag-facet chip row (the 8 `FACETS` from `apps/api/src/pipeline/tags.ts`); multi-select filters the in-memory list. Recency/score sort toggle.
   - Card click → `navigate('/design/:id')`.

6. **Thread `generationId`** — `ReferenceConfig`/`fetchConfig`: when viewing a design with an `id` (fresh generation or gallery design), pass it so Terraform persists to the row. Fresh generations: capture `id` from the generate response.

7. **CSS** — `apps/web/src/index.css`: reuse `.card` + `.gallery__item`; add `.tag-chip` / `.tag-chip--on` using existing tokens (`--brand-dark`, `--card`, `--serif`).

## Visibility rules (load-bearing)

- `GET /api/designs` and `/api/designs/:id` return **`approved` only**; pending/hidden → 404.
- Submitter's own fresh result shows live (response returned directly) + localStorage history — unchanged.
- Deep-links to not-yet-approved designs 404 for everyone (no auth to distinguish the submitter).
- Phase 1's downvote auto-hide (`GENERATION_HIDE_NET_VOTES`, default −3) removes an approved design from the gallery automatically.

## Verification

- **Backend:** `GET /api/designs` excludes pending/hidden; `GET /api/designs/:id` 404s on pending/hidden; vote route unchanged. New route tests.
- **Frontend:** gallery lists approved designs; tag chips filter; card click renders via `<DesignResult>` at `/design/:id`; the URL is shareable + reloads; Terraform pull on a gallery design passes `generationId` and the second pull is free; existing curated + generate flows unchanged.
- typecheck + build + tests green; **no new LLM cost** (gallery reads are $0 DB queries).

## Dependencies / coordination

- **Depends on Phase 1 (PR #5)** — the `generations` table, `GenerationsStore`, and the vote route. Branch Phase 2 off `main` after PR #5 merges.
- **`App.tsx` conflict:** `<DesignResult>` extraction + router setup both touch `App.tsx`, which the other agent is also editing. Reconcile on merge.
- `apps/api/src/routes/designs.ts` is Phase 1's — no conflict there.
