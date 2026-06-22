import { describe, expect, it, vi } from "vitest";
import { applyTemplate, type Probe, type ProbeContext, runProbe } from "../src/probe.js";

const BASE = new URL("https://team.example.workers.dev");

function ctx(fetchFn: typeof fetch, values: Record<string, string> = {}): ProbeContext {
  return { fetchFn, values, timeoutMs: 1_000, maxBodyBytes: 64 * 1024 };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe("applyTemplate", () => {
  it("should substitute known {keys} and leave unknown ones intact", () => {
    expect(applyTemplate("/p/{id}/x/{q}", { id: "42" })).toBe("/p/42/x/{q}");
  });
});

describe("runProbe", () => {
  const probe: Probe = {
    id: "healthz",
    request: { method: "GET", path: "/healthz" },
    expect: { status: 200, bodyIncludes: ["ok"] },
    description: "GET /healthz が 200 を返すこと",
  };

  it("should pass when status and body match", async () => {
    const fetchFn = vi.fn(async () => jsonResponse('{"ok":true}')) as unknown as typeof fetch;
    const out = await runProbe(BASE, probe, ctx(fetchFn));
    expect(out.passed).toBe(true);
    expect(out.detail).toBe("OK");
  });

  it("should fail on unexpected status and reveal only the participant's own status", async () => {
    const fetchFn = vi.fn(async () => jsonResponse("nope", 500)) as unknown as typeof fetch;
    const out = await runProbe(BASE, probe, ctx(fetchFn));
    expect(out.passed).toBe(false);
    expect(out.detail).toContain("500");
  });

  it("should fail when a required body substring is missing", async () => {
    const fetchFn = vi.fn(async () => jsonResponse('{"status":"up"}')) as unknown as typeof fetch;
    const out = await runProbe(BASE, probe, ctx(fetchFn));
    expect(out.passed).toBe(false);
    expect(out.detail).toContain("一致しません");
  });

  it("should fail when a banned substring leaks (bodyExcludes)", async () => {
    const leaky: Probe = {
      id: "no-leak",
      request: { method: "GET", path: "/debug" },
      expect: { bodyExcludes: ["stacktrace"] },
      description: "内部例外を漏らさないこと",
    };
    const fetchFn = vi.fn(async () =>
      jsonResponse("Error: stacktrace at ..."),
    ) as unknown as typeof fetch;
    const out = await runProbe(BASE, leaky, ctx(fetchFn));
    expect(out.passed).toBe(false);
    expect(out.detail).toContain("出してはいけない");
  });

  it("should accept a set of allowed statuses", async () => {
    const p: Probe = { ...probe, expect: { status: [200, 204] } };
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    expect((await runProbe(BASE, p, ctx(fetchFn))).passed).toBe(true);
  });

  it("should fail (not throw) when the endpoint is unreachable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = await runProbe(BASE, probe, ctx(fetchFn));
    expect(out.passed).toBe(false);
    expect(out.detail).toContain("到達できませんでした");
  });

  it("should abort and fail when the request exceeds the timeout", async () => {
    const hangingFetch = vi.fn(
      (_url: URL | string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const out = await runProbe(BASE, probe, {
      fetchFn: hangingFetch,
      values: {},
      timeoutMs: 5,
      maxBodyBytes: 4096,
    });
    expect(out.passed).toBe(false);
    expect(out.detail).toContain("到達できませんでした");
  });

  it("should fail when the response body exceeds the cap", async () => {
    const p: Probe = { ...probe, expect: {} };
    const big = "x".repeat(100);
    const fetchFn = vi.fn(async () => jsonResponse(big)) as unknown as typeof fetch;
    const out = await runProbe(BASE, p, {
      fetchFn,
      values: {},
      timeoutMs: 1_000,
      maxBodyBytes: 10,
    });
    expect(out.passed).toBe(false);
    expect(out.detail).toContain("大きすぎます");
  });

  it("should pass an empty-body response when no body expectations are set", async () => {
    const p: Probe = { ...probe, expect: { status: 204 } };
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    expect((await runProbe(BASE, p, ctx(fetchFn))).passed).toBe(true);
  });

  it("should substitute run values into path, headers and body, and not follow redirects", async () => {
    const p: Probe = {
      id: "idor",
      request: {
        method: "POST",
        path: "/profiles/{victimId}",
        headers: { Authorization: "Bearer {attackerToken}" },
        body: '{"id":"{victimId}"}',
      },
      expect: { status: 403 },
      description: "他人のプロフィールを更新できないこと",
    };
    const seen: { url: string; init?: RequestInit } = { url: "" };
    const fetchFn = vi.fn(async (url: URL | string, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return jsonResponse("forbidden", 403);
    }) as unknown as typeof fetch;
    const out = await runProbe(BASE, p, ctx(fetchFn, { victimId: "v-9", attackerToken: "t-1" }));
    expect(out.passed).toBe(true);
    expect(seen.url).toBe("https://team.example.workers.dev/profiles/v-9");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer t-1");
    expect(seen.init?.body).toBe('{"id":"v-9"}');
    expect(seen.init?.redirect).toBe("manual");
  });
});
