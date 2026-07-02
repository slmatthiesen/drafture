import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DesignSummary } from "../lib/types.js";

import { GalleryView } from "./GalleryView.js";

function summary(over: Partial<DesignSummary> & Pick<DesignSummary, "id">): DesignSummary {
  return {
    description: "a design",
    recommendedTier: "balanced",
    tags: [],
    upvotes: 0,
    downvotes: 0,
    genCount: 1,
    model: "claude-sonnet-4-6",
    createdAt: 0,
    ...over,
  };
}

const DESIGNS: DesignSummary[] = [
  summary({ id: "a", description: "photo sharing api", tags: ["media"], upvotes: 5, downvotes: 1, createdAt: 100 }),
  summary({ id: "b", description: "realtime chat", tags: ["chat"], recommendedTier: "resilient", upvotes: 2, createdAt: 200 }),
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderGallery(): void {
  render(
    <MemoryRouter initialEntries={["/gallery"]}>
      <GalleryView />
    </MemoryRouter>,
  );
}

describe("GalleryView", () => {
  it("lists approved designs and filters by a type chip", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ designs: DESIGNS }));
    renderGallery();

    expect(await screen.findByText("photo sharing api")).toBeInTheDocument();
    expect(screen.getByText("realtime chat")).toBeInTheDocument();

    // Selecting the "Chat" type narrows to the design carrying it.
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByText("photo sharing api")).not.toBeInTheDocument();
    expect(screen.getByText("realtime chat")).toBeInTheDocument();

    // Clearing it restores the full list.
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByText("photo sharing api")).toBeInTheDocument();
  });

  it("casts a vote through POST /api/designs/:id/vote and reflects the new count", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/vote")
          ? jsonResponse({ upvotes: 6, downvotes: 1 })
          : jsonResponse({ designs: DESIGNS }),
      ),
    );
    renderGallery();
    await screen.findByText("photo sharing api");

    fireEvent.click(screen.getAllByRole("button", { name: "Upvote design" })[0]!);

    await waitFor(() => expect(screen.getByText("▲ 6")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/designs/a/vote",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an empty-state message when no designs are approved", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ designs: [] }));
    renderGallery();
    expect(await screen.findByText(/No community designs yet/i)).toBeInTheDocument();
  });
});
