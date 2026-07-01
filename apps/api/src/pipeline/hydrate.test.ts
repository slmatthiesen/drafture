import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import catalog from "@drafture/kb/service-catalog.json" with { type: "json" };
import type { ServiceCatalog } from "@drafture/kb";

import { hydrateArchitecture, hydrateNode } from "./hydrate.js";
import { isComplianceFlagged, paidSecurityActive } from "./securityTiers.js";
import { normalizeServiceKey } from "./terraform/serviceKey.js";
import type { ArchitectureNode, KeyDecision, LeanNode, PreHydrationArchitecture, TierName } from "../schema/architecture.js";

const CATALOG = catalog as ServiceCatalog;

describe("hydrateNode", () => {
  it("fills the canonical awsService + floor tags for a known svc", () => {
    const node = hydrateNode({ svc: "sqs", id: "q" }, "budget", false);
    expect(node.id).toBe("q");
    expect(node.awsService).toBe(CATALOG["sqs"]!.awsService);
    expect(node.role).toBe(CATALOG["sqs"]!.defaultRole);
    expect(node.security).toEqual([]); // sqs has no universal floor tags in the current catalog
  });

  it("uses the explicit role when given, else the catalog default", () => {
    const withRole = hydrateNode({ svc: "lambda", id: "fn", role: "thumbnail worker" }, "budget", false);
    expect(withRole.role).toBe("thumbnail worker");
    const withoutRole = hydrateNode({ svc: "lambda", id: "fn" }, "budget", false);
    expect(withoutRole.role).toBe(CATALOG["lambda"]!.defaultRole);
  });

  it("appends and dedupes addSecurity on top of the floor", () => {
    const node = hydrateNode(
      { svc: "s3", id: "bucket", addSecurity: ["versioning enabled", "SSE-KMS"] },
      "budget",
      false,
    );
    const floor = CATALOG["s3"]!.floorTags;
    for (const tag of floor) expect(node.security).toContain(tag);
    expect(node.security).toContain("versioning enabled");
    // "SSE-KMS" is already a floor tag — must not be duplicated by addSecurity.
    expect(node.security.filter((t) => t === "SSE-KMS")).toHaveLength(1);
  });

  it("omits paidTags on budget (non-compliant) but includes them at balanced+", () => {
    const budget = hydrateNode({ svc: "cloudfront", id: "cf" }, "budget", false);
    const balanced = hydrateNode({ svc: "cloudfront", id: "cf" }, "balanced", false);
    const paid = CATALOG["cloudfront"]!.paidTags ?? [];
    expect(paid.length).toBeGreaterThan(0);
    for (const tag of paid) {
      expect(budget.security).not.toContain(tag);
      expect(balanced.security).toContain(tag);
    }
  });

  it("includes paidTags on budget when the design is compliance-flagged", () => {
    const node = hydrateNode({ svc: "cloudfront", id: "cf" }, "budget", true);
    const paid = CATALOG["cloudfront"]!.paidTags ?? [];
    for (const tag of paid) expect(node.security).toContain(tag);
  });

  it("falls back to the verbatim svc + only addSecurity for an unknown service", () => {
    const node = hydrateNode({ svc: "some-brand-new-thing", id: "n", addSecurity: ["custom tag"] }, "budget", false);
    expect(node.awsService).toBe("some-brand-new-thing");
    expect(node.role).toBe("some-brand-new-thing");
    expect(node.security).toEqual(["custom tag"]);
  });

  it("passes an already-hydrated (full) node through untouched", () => {
    const full: ArchitectureNode = { id: "x", awsService: "Amazon S3", role: "object store", security: ["custom"] };
    expect(hydrateNode(full, "budget", false)).toBe(full);
  });
});

describe("hydrateArchitecture", () => {
  it("hydrates every tier and reports zero catalog misses for known services", () => {
    const pre: PreHydrationArchitecture = {
      assumptions: [],
      clarificationsUsed: [],
      keyDecisions: [],
      tiers: [
        {
          name: "budget",
          summary: "s",
          nodes: [{ svc: "lambda", id: "fn" } satisfies LeanNode],
          edges: [],
          delta: [],
          tradeoffs: [],
        },
      ],
    };
    const { architecture, catalogMiss } = hydrateArchitecture(pre);
    expect(catalogMiss).toBe(0);
    expect(architecture.tiers[0]!.nodes[0]!.awsService).toBe(CATALOG["lambda"]!.awsService);
  });

  it("counts a catalog miss for an unrecognized svc", () => {
    const pre: PreHydrationArchitecture = {
      assumptions: [],
      clarificationsUsed: [],
      keyDecisions: [],
      tiers: [
        {
          name: "budget",
          summary: "s",
          nodes: [{ svc: "quantum-flux-capacitor", id: "n" } satisfies LeanNode],
          edges: [],
          delta: [],
          tradeoffs: [],
        },
      ],
    };
    expect(hydrateArchitecture(pre).catalogMiss).toBe(1);
  });
});

// --- GOLDEN NEUTRALITY (the invariant, docs/plans/2026-07-01-009) --------------
//
// For each real dogfood design, derive the LEAN form of every node (svc via the
// SAME normalizer the emitter uses; role kept explicit; addSecurity = its tags
// MINUS the catalog's floor/paid tags for that key+tier+compliance) and assert
// hydrateNode(lean) reproduces the original security tags (set-equal — order and
// duplicate-vs-catalog don't matter). This both proves neutrality AND validates
// the catalog authoring: if a design's tags can't be reproduced, the catalog
// entry is wrong. `awsService` is NOT asserted byte-for-byte: Layer A moves
// instance-size annotations the model used to embed in `awsService` (e.g.
// "Lambda (arm64, 2048 MB)") into `role`/`addSecurity` instead — a canonical
// name is the intended, better shape going forward.
const DOGFOOD_DESIGNS = ["happyhourfriends", "trade-monitoring-handoff"];

interface DogfoodNode {
  id: string;
  awsService: string;
  role: string;
  security: string[];
}
interface DogfoodTier {
  name: TierName;
  nodes: DogfoodNode[];
}
interface DogfoodDesign {
  assumptions: string[];
  keyDecisions: KeyDecision[];
  tiers: DogfoodTier[];
}

function loadDogfoodDesign(name: string): DogfoodDesign {
  const url = new URL(`../../../../dogfood/${name}/design.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as DogfoodDesign;
}

function deriveLeanNode(node: DogfoodNode, tierName: TierName, compliance: boolean): LeanNode {
  const key = normalizeServiceKey({ awsService: node.awsService, role: node.role });
  const entry = CATALOG[key];
  const floor = new Set(entry?.floorTags ?? []);
  const paid = new Set(entry && paidSecurityActive(tierName, compliance) ? (entry.paidTags ?? []) : []);
  const addSecurity = node.security.filter((tag) => !floor.has(tag) && !paid.has(tag));
  return { svc: node.awsService, id: node.id, role: node.role, addSecurity };
}

describe("golden neutrality — hydrate(lean(design)) reproduces the real dogfood designs", () => {
  for (const name of DOGFOOD_DESIGNS) {
    const design = loadDogfoodDesign(name);
    const compliance = isComplianceFlagged({
      assumptions: design.assumptions,
      keyDecisions: design.keyDecisions,
      tiers: design.tiers as never,
    });

    for (const tier of design.tiers) {
      it(`reproduces every node's security tags on ${name}/${tier.name}`, () => {
        for (const node of tier.nodes) {
          const lean = deriveLeanNode(node, tier.name, compliance);
          const hydrated = hydrateNode(lean, tier.name, compliance);
          expect(hydrated.id).toBe(node.id);
          expect(new Set(hydrated.security)).toEqual(new Set(node.security));
        }
      });
    }
  }
});
