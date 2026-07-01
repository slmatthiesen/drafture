# Layer A — Service Catalog: build spec (self-contained)

**Status:** ready-to-build (2026-07-01). **For:** an implementer with NO prior context.
**Parent:** `docs/plans/2026-06-30-008-service-catalog-and-agent-memory.md` (Layer A only).

## Goal

Stop the model from re-typing canned per-node boilerplate. Today the model emits each
node in full — `{id, awsService, role, security[]}` (~40 output tok/node; the `security[]`
tags alone are ~46% of the node block and are a pure function of the service + the tier's
security floor). Change it to emit a **lean pick** — `{svc, id, role?, addSecurity?}` — and
have the server **hydrate** the full node deterministically from a KB **service catalog**
(a `serviceKey → {awsService, floorTags, paidTags, …}` hash). $0, sub-µs, on every
generation. Expected: ~10–12% fewer output tokens (more if `assumptions`/`clarificationsUsed`
mandates are trimmed too — out of scope here).

**Non-goals:** semantic/vector memory, Redis, edge leaning (edges are already minimal),
trimming keyDecisions/assumptions. Those are separate.

## Invariant (the whole point)

`hydrate(leanGraph)` MUST be byte-identical to the graph the model used to emit, for the
existing dogfood designs, so nothing downstream (cost, completeness gate, Terraform
emitter, web) changes behavior. A golden test proves this before ship.

---

## Current-state anchors (files + symbols the builder will touch)

- **`apps/api/src/schema/architecture.ts`**
  - `NodeSchema` = `{ id, awsService, role, security: string[] }` (the FULL node; stays as
    the RESULT/hydrated type).
  - Wire schemas the model fills (these carry nodes and must go lean):
    `GeneratedTierSchema` (`.nodes`), `GeneratedTierDeltaSchema` (`.addNodes`),
    `GeneratedWireSchema` (`baseTier` + `tierDeltas`), `GeneratedBudgetWireSchema` (`baseTier`).
  - Reconstructors: `reconstructTiers`, `reconstructBudgetOnly`, `reconstructAddedTier`,
    `applyTierDelta` (upsert nodes by `id`). Types: `GeneratedTier`, `GeneratedArchitecture`,
    `ArchitectureBeforeCost` (= `GeneratedArchitecture` + `securityFloor` + `recommendedTier`
    + `recommendationRationale`).
  - JSON-schema builders for forced-tool use: `architectureJsonSchema`,
    `budgetArchitectureJsonSchema`, `addTierJsonSchema` (via `zodToJsonSchema`).
- **`apps/api/src/pipeline/terraform/serviceKey.ts`** — `normalizeServiceKey(node)` and the
  `ServiceKey` union. **Reuse this normalizer** so catalog keys == the TF/emitter vocabulary
  (one vocabulary everywhere). Note it matches on `awsService`; here we normalize the lean
  `svc` string instead — pass `{ awsService: svc, role: "" }`.
- **`apps/api/src/pipeline/securityTiers.ts`**
  - `paidSecurityActive(tierName, compliance): boolean` — the single switch for "this tier
    carries the PAID floor" (balanced+, or budget under compliance).
  - `isComplianceFlagged({assumptions, keyDecisions, tiers:[{nodes}]}): boolean` — reads
    regime markers from assumptions + keyDecisions + node `role` + node `security`. **All of
    these exist pre-hydration** (role + `addSecurity` carry any regime tag), so compliance is
    computable on the LEAN graph — no ordering hazard.
  - Gate context: `paidSecurityMarkersOnTier(tier)` flags a BUDGET tier that carries paid
    markers ("customer-managed CMK", "WAF", …). **Therefore hydrate must add `paidTags` ONLY
    when `paidSecurityActive(tier, compliance)` is true**, or the budget-cost-honesty gate
    (`budgetTierIsCostHonest`, a hard gate) will fail. This is the load-bearing rule.
- **`apps/api/src/pipeline/generate.ts`** — `generateArchitecture` (3-tier),
  `generateBudgetArchitecture` (budget-only, the default), `addTierToDesign` (one added
  tier). These are the pipeline entrypoints the route/evals/stress-test call. **Hydrate
  here.**
- **`apps/api/src/llm/provider.ts`** + `claude.ts` + `glm.ts` — `generate(prompt, opts, scope)`
  returns `ProviderResult<GeneratedArchitecture>` via `resolveGenerateScope().reconstruct`
  (`llm/generateScope.ts`). After this change the provider returns a **lean** architecture;
  the pipeline hydrates. Provider unit tests (`claude.test.ts`, `glm.test.ts`) assert on the
  returned tiers → update them to the lean shape (small).
- **`apps/api/src/pipeline/ground.ts`** — `SYSTEM_PROMPT`. The "OUTPUT STYLE" + node
  description paragraphs teach node emission; update them to teach LEAN emission.
- **`packages/kb/`** — JSON assets + `src/index.ts` types; `package.json` `exports` map lists
  each json (add the new one). Import pattern: `import x from "@drafture/kb/foo.json" with { type: "json" }`.

---

## Design

### 1. The catalog — `packages/kb/service-catalog.json`

Keyed by `ServiceKey`. Value:

```jsonc
// service-catalog.json
{
  "sqs":  { "awsService": "Amazon SQS",  "defaultRole": "job queue",       "floorTags": ["DLQ", "idempotent consumer", "SSE"], "paidTags": ["customer-managed CMK"] },
  "s3":   { "awsService": "Amazon S3",   "defaultRole": "object store",    "floorTags": ["block public access", "SSE-KMS at rest", "TLS-only bucket policy"], "paidTags": ["customer-managed CMK"] },
  "dynamo":{ "awsService": "Amazon DynamoDB", "defaultRole": "primary datastore", "floorTags": ["SSE at rest (AWS-managed)", "PITR", "least-priv role"], "paidTags": ["customer-managed CMK"] },
  "lambda":{ "awsService": "AWS Lambda", "defaultRole": "compute",         "floorTags": ["least-priv role", "TLS"], "paidTags": [] },
  "apigw":{ "awsService": "Amazon API Gateway (HTTP API)", "defaultRole": "front door", "floorTags": ["throttling", "TLS", "access logging"], "paidTags": ["WAF"] },
  "rds":  { "awsService": "Amazon RDS (PostgreSQL)", "defaultRole": "relational datastore", "floorTags": ["private subnet", "SSE at rest", "no public access"], "paidTags": ["customer-managed CMK", "multi-AZ"], "vpcBound": true }
  // …one entry per ServiceKey the emitter templates (cloudfront, ec2, postgres-selfmanaged,
  // eventbridge-*, secrets-manager, ssm, cloudwatch-*, sns, xray, cloudtrail, alb, fargate,
  // elasticache, nat, cognito, ses, step-functions, kinesis, opensearch). Author from the
  // dogfood designs' existing tags so hydrate reproduces them (see the golden test).
}
```

Type in `packages/kb/src/index.ts`:

```ts
export interface ServiceCatalogEntry {
  awsService: string;         // canonical name the hydrated node.awsService gets
  defaultRole?: string;       // used when the lean node omits `role`
  floorTags: string[];        // FREE-floor security tags — applied at EVERY tier
  paidTags?: string[];        // PAID-floor tags — applied ONLY when paidSecurityActive(tier,compliance)
  vpcBound?: boolean;         // informational; the TF layer already derives this itself
}
export type ServiceCatalog = Record<string, ServiceCatalogEntry>;
```

Add `"./service-catalog.json": "./service-catalog.json"` to `packages/kb/package.json` `exports`.

**Authoring rule:** floorTags/paidTags must reproduce what the dogfood budget/balanced/
resilient tiers already carry (the golden test diffs against them). Keep tags SHORT (they’re
control labels, not prose). `paidTags` = only the things `paidSecurityActive` implies
(customer-managed CMK; WAF on the edge; multi-AZ on stores) — never in a budget/none tier.

### 2. Lean node schema — `schema/architecture.ts`

```ts
export const LeanNodeSchema = z.object({
  svc: z.string().describe("Service key — the AWS service, e.g. 'sqs','dynamodb','lambda','s3','api gateway'. Normalized server-side to pull canned config."),
  id: z.string().describe("Stable node id, referenced by edges."),
  role: z.string().optional().describe("SHORT role label ONLY if it differs from the service's default (e.g. 'thumbnail worker'). Omit to accept the default."),
  addSecurity: z.array(z.string()).optional().describe("ONLY design-specific security controls the standard floor can't know (e.g. 'idempotent — key = job hash'). Do NOT restate standard tags like 'SSE-KMS' / 'block public access' — those are added for you."),
});
export type LeanNode = z.infer<typeof LeanNodeSchema>;
```

Swap `NodeSchema` → `LeanNodeSchema` in the WIRE schemas ONLY:
`GeneratedTierSchema.nodes`, `GeneratedTierDeltaSchema.addNodes`. (Leave `NodeSchema`,
`TierSchema`, `ArchitectureResultSchema` as the FULL/hydrated types.) `reconstruct*` and
`applyTierDelta` are unchanged structurally (still upsert by `id`) — they now carry lean
nodes; their return types become "lean" `GeneratedTier`/`GeneratedArchitecture`. Introduce
type aliases `LeanGeneratedTier`/`LeanGeneratedArchitecture` for clarity, or reuse the
existing type names and hydrate to the full ones (builder's choice; keep it typed).

### 3. Hydration — `apps/api/src/pipeline/hydrate.ts` (new)

```ts
import catalog from "@drafture/kb/service-catalog.json" with { type: "json" };
import type { ServiceCatalog } from "@drafture/kb";
import { normalizeServiceKey } from "./terraform/serviceKey.js";
import { isComplianceFlagged, paidSecurityActive } from "./securityTiers.js";
// types: LeanNode, ArchitectureNode(full), lean vs full tier/architecture

const CAT = catalog as ServiceCatalog;

/** Lean node + tier context → full ArchitectureNode. Deterministic, $0. */
export function hydrateNode(lean: LeanNode, tierName: TierName, compliance: boolean): ArchitectureNode {
  const key = normalizeServiceKey({ awsService: lean.svc, role: "" });
  const entry = CAT[key];
  const awsService = entry?.awsService ?? lean.svc;                 // fallback: verbatim
  const role = lean.role ?? entry?.defaultRole ?? lean.svc;
  const floor = entry?.floorTags ?? [];
  const paid = entry && paidSecurityActive(tierName, compliance) ? (entry.paidTags ?? []) : [];
  const security = dedupe([...floor, ...paid, ...(lean.addSecurity ?? [])]);
  return { id: lean.id, awsService, role, security };
}

/** Hydrate every tier of a lean architecture. Compliance is computed ONCE on the lean
 *  surface (assumptions + keyDecisions + role + addSecurity) — all present pre-hydration. */
export function hydrateArchitecture(lean: LeanGeneratedArchitecture): GeneratedArchitecture {
  const compliance = isComplianceFlagged({
    assumptions: lean.assumptions,
    keyDecisions: lean.keyDecisions,
    tiers: lean.tiers.map((t) => ({ nodes: t.nodes.map((n) => ({ role: n.role ?? "", security: n.addSecurity ?? [] })) })),
  } as never);
  return {
    ...lean,
    tiers: lean.tiers.map((t) => ({ ...t, nodes: t.nodes.map((n) => hydrateNode(n, t.name, compliance)) })),
  };
}

/** For addTierToDesign: hydrate ONE added tier given the budget baseline for compliance. */
export function hydrateAddedTier(leanTier: LeanGeneratedTier, budgetTier: GeneratedTier /*full*/): GeneratedTier {
  const compliance = isComplianceFlagged({ assumptions: [], keyDecisions: [], tiers: [budgetTier, /*lean surface of*/ leanTierSurface(leanTier)] } as never);
  return { ...leanTier, nodes: leanTier.nodes.map((n) => hydrateNode(n, leanTier.name, compliance)) };
}
```

Notes: `normalizeServiceKey` returns `"unsupported"` for an unknown `svc` → `entry`
undefined → node keeps `awsService = svc` and only `addSecurity` as tags (novel services
still work). `dedupe` preserves first-seen order.

### 4. Wire-in (minimal blast radius) — `pipeline/generate.ts`

The provider now returns a LEAN architecture. Hydrate in the pipeline entrypoints, BEFORE
`sanitizeGenerated`/`securityFloor`/`estimateCosts` — everything downstream sees full nodes:

- `generateBudgetArchitecture`: `const lean = await provider.generate(prompt, opts, {kind:"budget"}); const full = hydrateArchitecture(lean); const cleaned = sanitizeGenerated(full); …`
- `generateArchitecture`: same with `{kind:"full"}` (3 tiers).
- `addTierToDesign`: `const lean1 = provider.generate(…, {kind:"addTier", budgetTier, target}); return { tier: hydrateAddedTier(lean1.tiers[0], budgetTier), usage };` — NOTE `budgetTier` here is the client-sent FULL budget tier, so compliance sees the real tags.

`sanitizeGenerated` runs on the full node — verify it still targets `awsService`/`security`
(it fixes a "private subnet" tag on a managed/serverless service); it operates post-hydrate,
so it sees the canned tags — keep it after hydrate.

### 5. Prompt — `pipeline/ground.ts`

In `SYSTEM_PROMPT`, replace the node-emission instruction with lean guidance:

> A node is a lean PICK: `svc` (the AWS service — 'lambda','dynamodb','sqs','api gateway',
> 's3',…), a stable `id`, and OPTIONALLY a `role` (only if it differs from the service's
> default) and `addSecurity` (ONLY design-specific controls). Do NOT type standard security
> tags (SSE-KMS, block public access, DLQ, private subnet, least-priv) — the safe-by-default
> floor for each service is added for you server-side. Emit the DECISION, not the boilerplate.

Keep the tiered-floor / decision-graph-coherence / observability paragraphs — they still
govern WHICH services and HOW they wire. The forced-tool schema enforces the lean SHAPE, so
even an over-eager model can't emit a full node.

---

## Test plan (all $0 unless noted)

1. **hydrate unit** (`pipeline/hydrate.test.ts`): known `svc` → canonical awsService +
   floorTags; `role` omitted → defaultRole; `addSecurity` appended + deduped; budget tier
   omits `paidTags`, balanced tier includes them, budget-under-compliance includes them;
   unknown `svc` → verbatim awsService + only addSecurity.
2. **GOLDEN NEUTRALITY** (the invariant): for each dogfood design
   (`dogfood/*/design.json`), derive the lean form of each node (svc from its awsService via
   `normalizeServiceKey`; role kept; addSecurity = its tags MINUS the catalog's floor/paid
   tags for that key+tier) and assert `hydrateNode(lean) ≡ original node` (set-equal on
   security). This both proves neutrality AND validates catalog authoring. If a design's
   tags can't be reproduced, the catalog entry is wrong — fix the catalog, not the test.
3. **catalog coverage** (`service-catalog.test.ts`): every `ServiceKey` the TF registry
   emits has a catalog entry (or is listed as an intentional omission), so lean emission and
   TF templating share one vocabulary.
4. **schema/provider**: update `claude.test.ts`/`glm.test.ts` fakes to emit lean wire; assert
   provider returns lean; pipeline `generate.test.ts` (route) still asserts full nodes post-
   hydrate (budget-only default → 1 full tier). All existing route tests must stay green.
5. **completeness/gate**: run the golden property suite (`apps/api/src/test/golden/…`) on a
   hydrated dogfood design — `graphHasNoDanglingEdges`, `primaryDatastoreReachable`,
   `budgetTierIsCostHonest`, `budgetHasNoPaidSecurityFloor` all green (they consume full
   nodes; unchanged).
6. **live sanity (optional, $0 via GLM)**: `LLM_PROVIDER=glm` generate one budget design,
   confirm it emits lean nodes, hydrate fills tags, TF still 100% coverage. Do NOT burn a
   paid Sonnet call for this.

## Acceptance criteria (Definition of Done)

- Golden neutrality test passes for BOTH dogfood designs, all tiers (hydrate ≡ original).
- Catalog covers every emitter `ServiceKey`; unknown-svc fallback verified.
- Full api + web suites green; both typechecks clean.
- Measured budget output tokens ↓ ≥10% vs pre-change on the same prompt (compare
  `apps/api/scripts/smokeBudget.ts` output tokens before/after — one GLM run, $0).
- `budgetTierIsCostHonest` + `budgetHasNoPaidSecurityFloor` still green (paidTags correctly
  gated by `paidSecurityActive`).
- A `catalog_miss` telemetry field on the generate line (count of lean nodes whose `svc`
  normalized to `unsupported`) so the next catalog entry to add is data, not guesswork.

## Risks & mitigations

- **Catalog drift from reality** → the golden-neutrality test is the guard: authored from
  the real dogfood tags, it fails if a tag set diverges.
- **Model tailors a floor tag we now suppress** → `addSecurity` preserves design-specific
  nuance; only the identical-every-time floor tags move server-side.
- **Compliance-before-hydrate** → compliance markers live in role/addSecurity/keyDecisions/
  assumptions, all pre-hydration; the floor tags themselves are NOT compliance markers, so
  there is no chicken-and-egg. Covered by test 1's budget-under-compliance case.
- **paidTags leaking into budget** → gated by `paidSecurityActive`; test 1 + the cost-honesty
  gate both assert it.

## File change checklist

- `packages/kb/service-catalog.json` (new) + `packages/kb/src/index.ts` (type) +
  `packages/kb/package.json` (exports).
- `apps/api/src/schema/architecture.ts` — `LeanNodeSchema`; wire schemas use it; lean types.
- `apps/api/src/pipeline/hydrate.ts` (new) + `hydrate.test.ts`.
- `apps/api/src/pipeline/generate.ts` — hydrate in the 3 entrypoints.
- `apps/api/src/pipeline/ground.ts` — lean emission prompt.
- `apps/api/src/llm/{claude,glm}.ts` return type note + `claude.test.ts`/`glm.test.ts` fakes.
- `apps/api/src/routes/generate.ts` — add `catalogMiss` to the telemetry record (+ obs type).
- Tests: `service-catalog.test.ts`, golden-neutrality in `hydrate.test.ts`.
```
