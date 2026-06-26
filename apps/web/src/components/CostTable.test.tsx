import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostTable } from "./CostTable.js";
import type { CostDriver } from "../lib/types.js";

const drivers: CostDriver[] = [
  { service: "Lambda", unit: "per 1k requests", estimateRange: "$0.20–$0.90", note: "" },
  { service: "RDS (db.t4g.micro)", unit: "$/hr", estimateRange: "$12–$25/mo", note: "single-AZ" },
  { service: "S3", unit: "$/GB-month", estimateRange: "$0.023/GB-mo", note: "" },
  {
    service: "NAT Gateway",
    unit: "$0.045/GB processed + $0.045/hr",
    estimateRange: "$33–$60/mo",
    note: "required by private-subnet default",
  },
];

const assumptions = [
  "Prices are AWS on-demand list prices for us-east-1; excludes Free Tier, Savings Plans, and Reserved Instances.",
];

describe("CostTable (U10 / R6)", () => {
  it("renders each driver in its NATIVE unit, not a forced per-1,000", () => {
    render(<CostTable drivers={drivers} assumptions={assumptions} />);

    // Native, heterogeneous units are shown verbatim.
    expect(screen.getByText("per 1k requests")).toBeInTheDocument();
    expect(screen.getByText("$/hr")).toBeInTheDocument();
    expect(screen.getByText("$/GB-month")).toBeInTheDocument();
    expect(screen.getByText("$0.045/GB processed + $0.045/hr")).toBeInTheDocument();
  });

  it("surfaces the NAT/egress private-subnet note", () => {
    render(<CostTable drivers={drivers} assumptions={assumptions} />);
    expect(screen.getByText("required by private-subnet default")).toBeInTheDocument();
    expect(screen.getByText("NAT Gateway")).toBeInTheDocument();
  });

  it("shows the on-demand list-price disclaimer from assumptions", () => {
    render(<CostTable drivers={drivers} assumptions={assumptions} />);
    expect(screen.getByText(/on-demand list prices/i)).toBeInTheDocument();
  });
});
