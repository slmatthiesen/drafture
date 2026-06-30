# Corpus candidates (preserved 2026-06-30)

8 cost-honest, gate-passing designs from the 10-design audit + the Drafture self-design,
preserved from ephemeral scratch so the audit spend (~$0.86 + ~$0.08) is not lost. Each
was re-gated at preservation: **13/13 properties AND `budgetTierIsCostHonest` PASS**.

| file | prompt source | budget floor |
|------|---------------|--------------|
| `ct-graphql.json` | GOLDEN_PROMPTS `ct-graphql` | $12 (single box) |
| `ct-ml-inference.json` | GOLDEN_PROMPTS `ct-ml-inference` | $12 |
| `ct-websocket-chat.json` | GOLDEN_PROMPTS `ct-websocket-chat` | $12 |
| `qa-etl-batch.json` | GOLDEN_PROMPTS `qa-etl-batch` | $0 serverless |
| `qa-order-processing.json` | GOLDEN_PROMPTS `qa-order-processing` | $0 |
| `qa-video-transcode.json` | GOLDEN_PROMPTS `qa-video-transcode` | $0 |
| `qa-webhook-fanout.json` | GOLDEN_PROMPTS `qa-webhook-fanout` | $0 |
| `drafture-self.json` | `drafture-self.prompt.md` (Drafture's own brief) | $0 serverless |

Excluded (do NOT add): `ct-ecommerce-api` ($116 bloat), `ct-steady-api` (dangling edge +
bloat) — old-posture, regenerate after the posture confirm; `qa-image-pipeline` (DLQ orphan).

**Next (offline, $0):** persist each to the DB as `pending` (`generations.upsert`, description =
the prompt source above), then `reviewGenerations.ts approve <id>`, then `backfillEmbeddings.ts`.
Grows the corpus 11 → 19 (better retrieval = cheaper future generations) and seeds the gallery.
See docs/plans/2026-06-30-003-quality-hardening-batch.md.
