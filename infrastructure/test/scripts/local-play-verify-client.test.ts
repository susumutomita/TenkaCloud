import { describe, expect, it, vi } from "vitest";
import { verifySubmission } from "../../../scripts/local-play/verify-client";

const VERIFY_URL = "http://127.0.0.1:18081/verify";
const CONTEXT = { teamId: "local", problemId: "sqli-demo" } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("verifySubmission", () => {
  it("should forward submission+context to /verify and return a correct verdict", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ correct: true, points: 150, message: "ok" }),
    );
    const result = await verifySubmission(VERIFY_URL, "' OR '1'='1", CONTEXT, { fetchImpl });

    expect(result).toEqual({ correct: true, points: 150, message: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(VERIFY_URL);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(init?.body as string)).toEqual({
      submission: "' OR '1'='1",
      context: CONTEXT,
    });
  });

  it("should return a wrong verdict without points", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ correct: false }));
    expect(await verifySubmission(VERIFY_URL, "nope", CONTEXT, { fetchImpl })).toEqual({
      correct: false,
    });
  });

  it("should refuse a non-loopback verify URL before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(
      verifySubmission("http://evil.example.com/verify", "x", CONTEXT, { fetchImpl }),
    ).rejects.toThrow(/Refusing non-loopback/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should fail loudly when the container is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(verifySubmission(VERIFY_URL, "x", CONTEXT, { fetchImpl })).rejects.toThrow(
      /unreachable/,
    );
  });

  it("should fail loudly on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    await expect(verifySubmission(VERIFY_URL, "x", CONTEXT, { fetchImpl })).rejects.toThrow(
      /returned HTTP 500/,
    );
  });

  it("should fail loudly on a non-JSON body", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    await expect(verifySubmission(VERIFY_URL, "x", CONTEXT, { fetchImpl })).rejects.toThrow(
      /non-JSON body/,
    );
  });

  it("should reject a verdict that violates the schema", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ correct: "yes" }));
    await expect(verifySubmission(VERIFY_URL, "x", CONTEXT, { fetchImpl })).rejects.toThrow(
      /invalid verdict/,
    );
  });

  it("should enforce a response body size cap", async () => {
    const huge = "x".repeat(70_000);
    const fetchImpl = vi.fn(async () => new Response(huge, { status: 200 }));
    await expect(verifySubmission(VERIFY_URL, "x", CONTEXT, { fetchImpl })).rejects.toThrow(
      /exceeds 65536 bytes/,
    );
  });

  it("should time out and fail loudly when /verify hangs", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      verifySubmission(VERIFY_URL, "x", CONTEXT, {
        fetchImpl: fetchImpl as typeof fetch,
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/unreachable/);
  });
});
