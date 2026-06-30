import { describe, it, expect } from "vitest";

import { reconstructTiers } from "./architecture.js";
import type { GeneratedWire, GeneratedTier } from "./architecture.js";

const node = (id: string, role = id): GeneratedTier["nodes"][number] => ({
  id,
  awsService: id,
  role,
  security: ["TLS"],
});
const edge = (from: string, to: string): GeneratedTier["edges"][number] => ({
  from,
  to,
  payload: "data",
  protocol: "HTTPS",
});

function wire(tierDeltas: GeneratedWire["tierDeltas"]): GeneratedWire {
  return {
    assumptions: ["a"],
    clarificationsUsed: [],
    keyDecisions: [],
    baseTier: {
      name: "budget",
      summary: "budget",
      nodes: [node("api"), node("db")],
      edges: [edge("api", "db")],
      delta: ["baseline"],
      tradeoffs: ["cheap"],
    },
    tierDeltas,
  };
}

const delta = (over: Partial<GeneratedWire["tierDeltas"][number]> & { name: "balanced" | "resilient" }): GeneratedWire["tierDeltas"][number] => ({
  name: over.name,
  summary: over.name,
  addNodes: over.addNodes ?? [],
  removeNodeIds: over.removeNodeIds ?? [],
  addEdges: over.addEdges ?? [],
  removeEdges: over.removeEdges ?? [],
  delta: over.delta ?? [],
  tradeoffs: over.tradeoffs ?? [],
});

describe("reconstructTiers", () => {
  it("produces exactly three tiers named budget/balanced/resilient", () => {
    const out = reconstructTiers(wire([delta({ name: "balanced" }), delta({ name: "resilient" })]));
    expect(out.tiers.map((t) => t.name)).toEqual(["budget", "balanced", "resilient"]);
  });

  it("inherits the tier below verbatim when a delta is empty (the whole point)", () => {
    const out = reconstructTiers(wire([delta({ name: "balanced" }), delta({ name: "resilient" })]));
    for (const t of out.tiers) {
      expect(t.nodes.map((n) => n.id)).toEqual(["api", "db"]);
      expect(t.edges).toEqual([edge("api", "db")]);
    }
  });

  it("adds new nodes and edges on top of the inherited graph", () => {
    const out = reconstructTiers(
      wire([
        delta({ name: "balanced", addNodes: [node("cache")], addEdges: [edge("api", "cache")] }),
        delta({ name: "resilient" }),
      ]),
    );
    expect(out.tiers[1]!.nodes.map((n) => n.id)).toEqual(["api", "db", "cache"]);
    expect(out.tiers[1]!.edges).toEqual([edge("api", "db"), edge("api", "cache")]);
    // resilient inherits balanced (including the added cache)
    expect(out.tiers[2]!.nodes.map((n) => n.id)).toEqual(["api", "db", "cache"]);
  });

  it("upserts a changed node in place by id (re-stated with same id replaces)", () => {
    const out = reconstructTiers(
      wire([delta({ name: "balanced", addNodes: [node("db", "db (multi-AZ)")] }), delta({ name: "resilient" })]),
    );
    const dbNodes = out.tiers[1]!.nodes.filter((n) => n.id === "db");
    expect(dbNodes).toHaveLength(1); // replaced, not duplicated
    expect(dbNodes[0]!.role).toBe("db (multi-AZ)");
  });

  it("removes nodes and edges named in the delta", () => {
    const out = reconstructTiers(
      wire([delta({ name: "balanced", removeNodeIds: ["db"], removeEdges: [{ from: "api", to: "db" }] }), delta({ name: "resilient" })]),
    );
    expect(out.tiers[1]!.nodes.map((n) => n.id)).toEqual(["api"]);
    expect(out.tiers[1]!.edges).toEqual([]);
  });

  it("prunes edges left dangling when a delta removes a node but forgets its edges", () => {
    // The model removes 'db' (e.g. budget's single box split out at balanced) but
    // does NOT list the api→db edge in removeEdges. Reconstruction must drop the
    // now-dangling edge rather than emit an edge to a removed node.
    const out = reconstructTiers(
      wire([delta({ name: "balanced", removeNodeIds: ["db"] }), delta({ name: "resilient" })]),
    );
    expect(out.tiers[1]!.nodes.map((n) => n.id)).toEqual(["api"]);
    expect(out.tiers[1]!.edges).toEqual([]); // api→db pruned with the removed node
    // resilient inherits the cleaned balanced graph (no dangling edge propagates up)
    expect(out.tiers[2]!.edges).toEqual([]);
  });

  it("does NOT prune a typo'd edge (re-added node id survives; unknown ids stay to be flagged)", () => {
    // removeNodeIds drops 'db', but the same delta re-adds 'db' AND its edge — the
    // node is present in the end, so the edge must survive (only truly-gone nodes prune).
    const out = reconstructTiers(
      wire([delta({ name: "balanced", removeNodeIds: ["db"], addNodes: [node("db", "db v2")], addEdges: [edge("api", "db")] }), delta({ name: "resilient" })]),
    );
    expect(out.tiers[1]!.nodes.map((n) => n.id)).toEqual(["api", "db"]);
    expect(out.tiers[1]!.edges).toEqual([edge("api", "db")]);
  });

  it("carries assumptions and keyDecisions through unchanged", () => {
    const w = wire([delta({ name: "balanced" }), delta({ name: "resilient" })]);
    const out = reconstructTiers(w);
    expect(out.assumptions).toEqual(w.assumptions);
    expect(out.keyDecisions).toEqual(w.keyDecisions);
  });
});
