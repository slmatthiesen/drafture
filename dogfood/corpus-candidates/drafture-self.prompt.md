A requirements brief for a web tool that recommends AWS architectures. A user
describes a workload in plain language, optionally answers a few clarifying questions,
and gets back a three-tier architecture (budget/balanced/resilient) with cost estimates
and an architecture-decision writeup. Describes the workload's shape and access patterns,
not the codebase. The LLM and embedding calls go to an external API and run off-AWS —
they are intentionally omitted as a persistence/compute concern.

## 1. Application profile

- A React single-page-app frontend plus a small JSON API. The frontend is mostly a form
  (submit a description, answer a couple of questions) and a results view.
- Public, read-heavy gallery: shareable permalinks for past designs (`/design/:id`) and
  programmatic SEO pages. Plus a tiny gated review queue for an operator to approve or
  hide submissions before they appear in the gallery.
- One synchronous generation path: prompt in → an external LLM call → deterministic
  post-processing (cost math, a security floor) → result out. Request/response, ~1–2
  minutes per call, no long-running or background jobs in production.

## 2. Compute

- **API tier:** stateless. Each request makes one external LLM call and returns. No
  always-on work, low concurrency, very bursty (often idle). Scale-to-zero is ideal —
  paying for an idle server is pure waste at this traffic.
- **Semantic retrieval step:** before the LLM call, embed the incoming prompt (external
  embeddings API) and rank a SMALL corpus of past designs by cosine similarity. The
  corpus is tens of vectors today, at most a few hundred at maturity; ranking is
  brute-force in process (load the vectors, compute cosine in memory). It is NOT a
  database query and needs no vector index.
- No headless rendering, no image/video processing, no GPU, no heavy CPU work.
- Corpus growth and embedding backfill are occasional OFFLINE operator jobs run from a
  CLI, not production services.

## 3. Data

- **Document / key-value storage,** accessed only by primary key or a simple status
  filter — no relational joins, no cross-entity transactions, no geospatial:
  - generated designs: `id → JSON blob`, with a status (pending / approved / hidden).
  - per-design vote and feedback counts.
  - a cached pricing table (service → price rows), refreshed periodically.
  - a small set of operator "memory" notes.
- **Embeddings:** a few dozen (eventually a few hundred) vectors stored as opaque blobs,
  loaded wholesale into memory for the cosine ranking above — never queried in the store.
- Write volume is tiny (a handful of generations per day at launch). Reads dominate
  (gallery + permalinks + SEO pages) and are highly cacheable.

## 4. Object storage

- Minimal: static frontend assets and the occasional exported artifact. CDN-fronted.
  Not a core part of the workload.

## 5. Traffic & scale

- **Very low today; optimize for cost first, not availability.** The system is idle the
  large majority of the time. Prefer pay-per-request / scale-to-zero so idle cost is
  effectively $0.
- Growth is in the VOLUME of stored designs (gallery content) and cacheable read pages,
  not in concurrent dynamic traffic.

## 6. Availability / SLA

- No strict SLA. Single-region, single-AZ is acceptable at current scale. A failed
  generation is simply retried by the user.
- The one durability concern: do not lose approved designs (the corpus). Light backups
  are fine; RPO/RTO are relaxed.

## 7. Geography

- Single region (US audience). A CDN handles global delivery of static assets and the
  cacheable gallery/SEO pages. No multi-region database requirement.
