import { StatusCodes } from "http-status-codes";
import { vi } from "vitest";

/** One outbound ingress call captured by the fetch stub. */
export interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** Fetch stub that records every call and replies with `response()`. */
export function captureFetch(response: () => Response): {
  fetchImpl: typeof fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return response();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, captured };
}

/** The ingress' happy-path reply (202 with its own requestId echo). */
export function acceptedIngressResponse(): Response {
  return new Response(JSON.stringify({ requestId: "ignored-by-worker" }), {
    status: StatusCodes.ACCEPTED,
  });
}

export function capturedAt(captured: CapturedRequest[], index: number): CapturedRequest {
  const request = captured[index];
  if (!request) throw new Error(`no captured request at index ${index}`);
  return request;
}
