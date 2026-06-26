import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostSummary } from "./CostSummary.js";
import { parseMonthlyRange, rollupCost } from "../lib/cost.js";
import type { CostDriver } from "../lib/types.js";

function driver(estimateRange: string): CostDriver {
  return { service: "svc", unit: "u", estimateRange, note: "" };
}

describe("cost rollup (lib/cost)", () => {
  it("parses monthly ranges and ignores per-unit / unparseable strings", () => {
    expect(parseMonthlyRange("$12–$30/mo")).toEqual({ low: 12, high: 30 });
    expect(parseMonthlyRange("$0.20–$0.90/mo")).toEqual({ low: 0.2, high: 0.9 });
    expect(parseMonthlyRange("$1,200 to $2,000/month")).toEqual({ low: 1200, high: 2000 });
    expect(parseMonthlyRange("$0.023/GB-mo")).toBeNull();
    expect(parseMonthlyRange("varies")).toBeNull();
  });

  it("sums the low and high ends across drivers", () => {
    const rollup = rollupCost([driver("$0.20–$0.90/mo"), driver("$12–$30/mo"), driver("$33–$60/mo")]);
    expect(rollup.low).toBeCloseTo(45.2);
    expect(rollup.high).toBeCloseTo(90.9);
    expect(rollup.partial).toBe(false);
    expect(rollup.counted).toBe(3);
  });

  it("flags partial when some drivers can't be summed", () => {
    const rollup = rollupCost([driver("$12–$30/mo"), driver("$0.023/GB-mo")]);
    expect(rollup.counted).toBe(1);
    expect(rollup.partial).toBe(true);
  });
});

describe("CostSummary", () => {
  it("renders an estimated monthly band from the drivers", () => {
    render(
      <CostSummary
        drivers={[driver("$0.20–$0.90/mo"), driver("$12–$30/mo"), driver("$33–$60/mo")]}
      />,
    );
    // 45.2 → "45", 90.9 → "91".
    expect(screen.getByText("~$45–$91/mo")).toBeInTheDocument();
    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
  });

  it("notes 'partial' when some drivers are unparseable", () => {
    render(<CostSummary drivers={[driver("$12–$30/mo"), driver("$0.023/GB-mo")]} />);
    expect(screen.getByText("~$12–$30/mo")).toBeInTheDocument();
    expect(screen.getByText(/partial/i)).toBeInTheDocument();
  });

  it("renders nothing when no driver has a monthly range", () => {
    const { container } = render(<CostSummary drivers={[driver("$0.023/GB-mo")]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
