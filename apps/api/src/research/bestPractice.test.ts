/**
 * U6 tests: research-on-miss → quarantine. A FAKE Anthropic client (no network)
 * drives canned web_search responses / error blocks; the MemoryStore is the real
 * SQLite impl via openTempDb/createStores.
 */
import { describe, it, expect } from "vitest";

import { openTempDb, createStores } from "../store/sqlite.js";
import { assembleGrounding } from "../pipeline/ground.js";
import {
  researchMissingTopics,
  type ResearchClient,
  type ResearchResponse,
  type ResearchConfig,
} from "./bestPractice.js";

const ON: ResearchConfig = {
  RESEARCH_ON_MISS: true,
  RESEARCH_MAX_CALLS_PER_REQUEST: 2,
  LLM_MODEL: "claude-sonnet-4-6",
  ANTHROPIC_API_KEY: "test-key",
};

function memoryStore() {
  return createStores(openTempDb()).memory;
}

/** Canned successful web_search research: a result block + a JSON fact text block. */
function goodResponse(
  fact = "Store uploads in S3 with SSE-KMS and presigned URLs.",
  source = "https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html",
): ResearchResponse {
  return {
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    content: [
      { type: "server_tool_use", name: "web_search", input: { query: "aws best practice" } },
      {
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", url: source, title: "AWS Docs" }],
      },
      {
        type: "text",
        text: JSON.stringify({ fact, rationale: "Protects data at rest and limits exposure.", source }),
      },
    ],
  };
}

/** web_search server-tool ERROR: HTTP 200, error object in `content` (not an exception). */
function errorBlockResponse(): ResearchResponse {
  return {
    stop_reason: "end_turn",
    usage: { input_tokens: 80, output_tokens: 0 },
    content: [
      {
        type: "web_search_tool_result",
        content: { type: "web_search_tool_error", error_code: "max_uses_exceeded" },
      },
    ],
  };
}

interface FakeClient extends ResearchClient {
  calls: Array<Record<string, unknown>>;
}

function fakeClient(responder: (body: Record<string, unknown>, n: number) => ResearchResponse | Promise<ResearchResponse>): FakeClient {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    messages: {
      create: async (body) => {
        calls.push(body);
        return responder(body, calls.length);
      },
    },
  };
}

describe("researchMissingTopics", () => {
  it("a miss triggers exactly one research call and persists a verified:false doc (happy)", async () => {
    const memory = memoryStore();
    const client = fakeClient(() => goodResponse());
    const spends: number[] = [];

    const summary = await researchMissingTopics({
      topics: ["file-uploads"],
      memory,
      anthropic: client,
      config: ON,
      onSpend: (u) => spends.push(u.inputTokens),
    });

    expect(client.calls.length).toBe(1);
    expect(summary.calls).toBe(1);
    expect(summary.researched).toEqual(["file-uploads"]);
    expect(summary.failures).toEqual([]);
    expect(summary.persisted).toHaveLength(1);

    const doc = summary.persisted[0]!;
    expect(doc.topic).toBe("file-uploads");
    expect(doc.verified).toBe(false); // QUARANTINE
    expect(doc.provenance).toBe("research");
    expect(doc.fact).toContain("S3");
    expect(doc.source).toContain("docs.aws.amazon.com");

    // Persisted and retrievable for the next request.
    expect((await memory.get("file-uploads"))?.id).toBe(doc.id);
    // Each call reported to the spend ledger.
    expect(spends).toEqual([100]);
  });

  it("a subsequent identical request reads from memory and does NOT re-research (R9)", async () => {
    const memory = memoryStore();
    const client = fakeClient(() => goodResponse());
    // "sign in" (not "login") so the description maps to exactly the
    // authentication topic: observability's "log" keyword matches inside "login",
    // which would split this into two missing topics and defeat the single-topic
    // no-re-research assertion below.
    const description = "Users sign up and sign in to their accounts.";

    // Round 1: the auth topic is a miss → research + quarantine it.
    const first = await assembleGrounding({ description, memory });
    expect(first.missingTopics).toContain("authentication");
    await researchMissingTopics({
      topics: first.missingTopics,
      memory,
      anthropic: client,
      config: ON,
    });
    expect(client.calls.length).toBe(1);

    // Round 2: the topic now has a memory hit → no longer missing → no new call.
    const second = await assembleGrounding({ description, memory });
    expect(second.missingTopics).not.toContain("authentication");
    expect(second.memoryHits.length).toBeGreaterThan(0);

    const summary = await researchMissingTopics({
      topics: second.missingTopics,
      memory,
      anthropic: client,
      config: ON,
    });
    expect(summary.calls).toBe(0);
    expect(client.calls.length).toBe(1); // unchanged — read from memory, not re-researched
  });

  it("flag off → no web calls (edge)", async () => {
    const memory = memoryStore();
    const client = fakeClient(() => goodResponse());

    const summary = await researchMissingTopics({
      topics: ["file-uploads", "authentication"],
      memory,
      anthropic: client,
      config: { ...ON, RESEARCH_ON_MISS: false },
    });

    expect(client.calls.length).toBe(0);
    expect(summary).toEqual({ researched: [], persisted: [], failures: [], calls: 0 });
    expect(await memory.listPending()).toEqual([]);
  });

  it("a server-tool error result block degrades gracefully and still returns (error)", async () => {
    const memory = memoryStore();
    const client = fakeClient(() => errorBlockResponse());

    const summary = await researchMissingTopics({
      topics: ["file-uploads"],
      memory,
      anthropic: client,
      config: ON,
    });

    expect(client.calls.length).toBe(1);
    expect(summary.persisted).toEqual([]);
    expect(summary.failures).toEqual(["file-uploads"]);
    expect(await memory.listPending()).toEqual([]);
  });

  it("a thrown failure/timeout degrades gracefully and still returns (error)", async () => {
    const memory = memoryStore();
    const client = fakeClient(() => {
      throw new Error("network timeout");
    });

    const summary = await researchMissingTopics({
      topics: ["file-uploads"],
      memory,
      anthropic: client,
      config: ON,
    });

    expect(summary.persisted).toEqual([]);
    expect(summary.failures).toEqual(["file-uploads"]);
  });

  it("per-request research count is capped at RESEARCH_MAX_CALLS_PER_REQUEST (R11)", async () => {
    const memory = memoryStore();
    const client = fakeClient(() => goodResponse());

    const summary = await researchMissingTopics({
      topics: ["file-uploads", "authentication", "notifications"],
      memory,
      anthropic: client,
      config: { ...ON, RESEARCH_MAX_CALLS_PER_REQUEST: 2 },
    });

    expect(client.calls.length).toBe(2);
    expect(summary.calls).toBe(2);
    expect(summary.researched).toEqual(["file-uploads", "authentication"]);
    expect(summary.persisted).toHaveLength(2);
    // The third topic is left untouched for a later request.
    expect(await memory.get("notifications")).toBeUndefined();
  });

  it("researched facts are verified:false, surface via listPending, and the CLI store ops promote/reject (R7/R9)", async () => {
    const memory = memoryStore();
    const client = fakeClient(() => goodResponse());

    const summary = await researchMissingTopics({
      topics: ["file-uploads"],
      memory,
      anthropic: client,
      config: ON,
    });
    const id = summary.persisted[0]!.id;

    // Surfaced as pending (what list-pending-facts prints).
    const pending = await memory.listPending();
    expect(pending.map((d) => d.id)).toContain(id);
    expect(pending.every((d) => d.verified === false)).toBe(true);

    // verify-fact <id> → trusted, no longer pending.
    expect(await memory.setVerified(id, true)).toBe(true);
    expect(await memory.listPending()).toEqual([]);
    expect((await memory.getById(id))?.verified).toBe(true);

    // verify-fact --reject <id> → deleted.
    expect(await memory.delete(id)).toBe(true);
    expect(await memory.getById(id)).toBeUndefined();
  });
});
