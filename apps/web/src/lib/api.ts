/**
 * Typed client for the single `/api/generate` endpoint.
 *
 * The endpoint is overloaded: an initial call may come back asking for
 * clarification (R2), and the answer-resubmit hits the SAME endpoint with
 * `answers` + an advanced `round`. `generate` and `clarify` are therefore the
 * same call — `clarify` is just the semantically-named alias for the resubmit.
 *
 * `fetch` is injectable so tests can pass a stub without touching globals.
 */

import type { GenerateResponse, ClarifyResponse } from "./types.js";

export interface GenerateRequest {
  description: string;
  answers?: string[];
  round?: number;
  turnstileToken?: string;
}

/** Discriminated union the UI switches on — never throws for HTTP/transport errors. */
export type ApiOutcome =
  | { kind: "clarify"; questions: string[]; round: number }
  | { kind: "result"; tiers: GenerateResponse["tiers"]; assumptions: string[] }
  | { kind: "error"; status: number; code: string; message?: string };

const ENDPOINT = "/api/generate";

export async function generate(
  body: GenerateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error", status: 0, code: "network_error" };
  }

  // Errors carry { error } (and 400 also { message }); a body may be absent.
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body — leave data null and fall through to code-by-status */
  }

  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; message?: string };
    return {
      kind: "error",
      status: res.status,
      code: obj.error ?? "unknown_error",
      message: obj.message,
    };
  }

  if (isClarify(data)) {
    return { kind: "clarify", questions: data.questions, round: data.round };
  }

  const result = (data ?? {}) as Partial<GenerateResponse>;
  return {
    kind: "result",
    tiers: result.tiers ?? [],
    assumptions: result.assumptions ?? [],
  };
}

/** Resubmit answers to advance a clarification round — same endpoint as {@link generate}. */
export const clarify = generate;

function isClarify(data: unknown): data is ClarifyResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { needsClarification?: unknown }).needsClarification === true
  );
}
