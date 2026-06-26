import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { GenerateResponse, Tier, TierName } from "./lib/types.js";

// jsdom can't run Mermaid's SVG renderer — stub the module to canned SVG.
// `vi.hoisted` lets the hoisted vi.mock factory reference renderMock safely.
const { renderMock } = vi.hoisted(() => ({
  renderMock: vi.fn(async (_id: string, chart: string) => ({ svg: `<svg data-len="${chart.length}">mock</svg>` })),
}));
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

import { App } from "./App.js";

function tier(name: TierName, summary: string, security: string): Tier {
  return {
    name,
    summary,
    nodes: [
      { id: "client", awsService: "Client", purpose: "", security: [], scaling: { burst: "", trivialInCore: true } },
      { id: "api", awsService: "API Gateway", purpose: "", security: [], scaling: { burst: "", trivialInCore: true } },
    ],
    edges: [{ from: "client", to: "api", payload: `${name} JSON request`, protocol: "HTTPS" }],
    setupSteps: [`${name} step one`],
    costDrivers: [
      { service: "NAT Gateway", unit: "$0.045/GB processed + $/hr", estimateRange: "$33–$60/mo", note: "required by private-subnet default" },
    ],
    burstHandling: [`${name} burst`],
    securityNotes: [security],
    tradeoffs: [`${name} tradeoff`],
  };
}

const fullResult: GenerateResponse = {
  assumptions: ["Prices are AWS on-demand list prices for us-east-1."],
  tiers: [
    tier("budget", "Budget single-AZ design", "Budget security floor intact"),
    tier("balanced", "Balanced multi-AZ design", "Balanced security note"),
    tier("resilient", "Resilient multi-region design", "Resilient security note"),
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  renderMock.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function typeAndSubmit(description: string): void {
  fireEvent.change(screen.getByLabelText("System description"), { target: { value: description } });
  fireEvent.click(screen.getByRole("button", { name: /design it/i }));
}

describe("App (U10)", () => {
  it("moves the prompt into the header and shows a loading state on submit", () => {
    // Pending fetch so we can observe the loading phase before it resolves.
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);

    render(<App />);
    typeAndSubmit("A photo-sharing API");

    // Prompt is now the page goal/header (the textbox is gone).
    expect(screen.getByRole("heading", { name: "A photo-sharing API" })).toBeInTheDocument();
    expect(screen.queryByLabelText("System description")).not.toBeInTheDocument();
    // Loading state visible.
    expect(screen.getByRole("status")).toHaveTextContent(/designing/i);
  });

  it("renders clarification questions, then advances to results after answering", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ needsClarification: true, questions: ["Expected traffic?"], round: 1 }))
      .mockResolvedValueOnce(jsonResponse(fullResult));

    render(<App />);
    typeAndSubmit("An async job processor");

    // Round 1: clarification form.
    const question = await screen.findByText("Expected traffic?");
    expect(question).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "about 100 rps" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Round 2: results render.
    await screen.findByText("Budget single-AZ design");
    expect(screen.getByText("Budget security floor intact")).toBeInTheDocument();

    // The resubmit carried the answers + advanced round.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.answers).toEqual(["about 100 rps"]);
    expect(secondBody.round).toBe(1);
  });

  it("re-renders diagram + cost + security when switching tiers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fullResult));

    render(<App />);
    typeAndSubmit("A REST API");

    await screen.findByText("Budget single-AZ design");
    // Budget is framed as minimum safe cost (KTD9) — tab sublabel + tier tag.
    expect(screen.getAllByText(/minimum safe cost/i).length).toBeGreaterThan(0);
    expect(renderMock).toHaveBeenCalled();
    const callsAfterBudget = renderMock.mock.calls.length;

    fireEvent.click(screen.getByRole("tab", { name: /balanced/i }));

    await screen.findByText("Balanced multi-AZ design");
    expect(screen.queryByText("Budget single-AZ design")).not.toBeInTheDocument();
    expect(screen.getByText("Balanced security note")).toBeInTheDocument();
    // The diagram re-rendered for the newly-selected tier.
    await waitFor(() => expect(renderMock.mock.calls.length).toBeGreaterThan(callsAfterBudget));
  });

  it("surfaces a friendly message for a rate-limit error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "rate_limited" }, 429));

    render(<App />);
    typeAndSubmit("Anything");

    expect(await screen.findByRole("alert")).toHaveTextContent(/going a little fast/i);
  });
});
