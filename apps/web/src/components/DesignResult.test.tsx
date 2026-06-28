import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GenerateResponse, Tier, TierName } from "../lib/types.js";

// jsdom can't run Mermaid's SVG renderer — stub it the same way App.test does.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, chart: string) => ({ svg: `<svg data-len="${chart.length}">mock</svg>` })),
  },
}));

import { DesignResult } from "./DesignResult.js";

function tier(name: TierName, summary: string): Tier {
  return {
    name,
    summary,
    nodes: [{ id: "api", awsService: "API Gateway", role: "edge", security: [] }],
    edges: [{ from: "client", to: "api", payload: "JSON", protocol: "HTTPS" }],
    delta: [`${name} delta`],
    costDrivers: [],
    tradeoffs: [],
  };
}

const result: GenerateResponse = {
  tiers: [tier("budget", "Budget design"), tier("balanced", "Balanced design"), tier("resilient", "Resilient design")],
  assumptions: ["us-east-1 list prices"],
  securityFloor: ["Encryption at rest with KMS"],
  recommendedTier: "balanced",
  recommendationRationale: "",
  keyDecisions: [
    { decision: "Compute model", chosen: "Serverless", alternativesConsidered: ["ECS"], rationale: "cheap idle" },
  ],
};

describe("DesignResult", () => {
  it("renders the selected tier, key decisions, security floor, and assumptions", () => {
    render(<DesignResult result={result} selectedTier="balanced" onSelectTier={() => {}} />);
    expect(screen.getByText("Balanced design")).toBeInTheDocument();
    expect(screen.getByText("Serverless")).toBeInTheDocument();
    expect(screen.getByText("KMS")).toBeInTheDocument();
    expect(screen.getByText("us-east-1 list prices")).toBeInTheDocument();
  });

  it("hides the feedback control when no feedback prop is given (deep-linked design)", () => {
    render(<DesignResult result={result} selectedTier="balanced" onSelectTier={() => {}} />);
    expect(screen.queryByRole("group", { name: "Rate this design" })).not.toBeInTheDocument();
  });

  it("shows the feedback control and reports a rating when feedback is provided (fresh result)", () => {
    const onRate = vi.fn();
    render(
      <DesignResult
        result={result}
        selectedTier="balanced"
        onSelectTier={() => {}}
        feedback={{ rating: null, busy: false, onRate }}
      />,
    );
    expect(screen.getByRole("group", { name: "Rate this design" })).toBeInTheDocument();
    screen.getByRole("button", { name: "Good design" }).click();
    expect(onRate).toHaveBeenCalledWith(1);
  });
});
