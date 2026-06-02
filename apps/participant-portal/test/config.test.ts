import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("should extract values when /runtime-config.json returns 200", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "https://api.example.com",
        eventTitle: "Real Event",
        eventRegion: "us-east-1",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toBe("https://api.example.com");
    expect(cfg.eventTitle).toBe("Real Event");
    expect(cfg.eventRegion).toBe("us-east-1");
    expect(cfg.mode).toBe("backend");
    expect(cfg.cloudMode).toBe("real");
  });

  it("should fall back to dev-mock when mode is missing from runtime-config", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ apiBaseUrl: "https://api.example.com" }),
    });
    const cfg = await loadConfig();
    expect(cfg.mode).toBe("dev-mock");
    expect(cfg.cloudMode).toBe("mock");
  });

  it("should load runtime-config with cloudMode=localstack", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "https://api.example.com",
        eventTitle: "Offline Event",
        eventRegion: "ap-northeast-1",
        mode: "backend",
        cloudMode: "localstack",
        localstackEndpoint: "http://localhost:4566/",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.mode).toBe("backend");
    expect(cfg.cloudMode).toBe("localstack");
    expect(cfg.localstackEndpoint).toBe("http://localhost:4566");
  });

  it("should not adopt localstackEndpoint as display endpoint when it is not localhost", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "https://api.example.com",
        mode: "backend",
        cloudMode: "localstack",
        localstackEndpoint: "https://example.com:4566",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.cloudMode).toBe("localstack");
    expect(cfg.localstackEndpoint).toBeUndefined();
  });

  it("should fill missing keys with fallbacks", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ apiBaseUrl: "https://x.example/api" }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toBe("https://x.example/api");
    // 他キーは fallback
    expect(cfg.eventTitle).toContain("dev mock");
    expect(cfg.eventRegion).toBe("ap-northeast-1");
  });

  it("should return fallback on 404", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toContain("dev-mock");
  });

  it("should return fallback when fetch throws", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toContain("dev-mock");
  });

  it("Issue #871: should fall back when apiBaseUrl is http:// in backend mode", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "http://attacker.evil.com/portal",
        eventTitle: "Spoofed",
        eventRegion: "us-east-1",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    // fallback の dev-mock URL に倒れる (= teamLoginKey を attacker に送らない)
    expect(cfg.apiBaseUrl).toContain("dev-mock");
    expect(cfg.mode).toBe("dev-mock");
    expect(cfg.cloudMode).toBe("mock");
  });

  it("Issue #871: should fall back when apiBaseUrl is an unparseable URL in backend mode", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        // `http://` 検査以前に `new URL()` 自体が throw する不正値。 HTTPS 強制ガードが
        // 例外を握り潰して 「HTTPS でない」 = fallback に倒すこと (= fail closed) を確認。
        apiBaseUrl: "not-a-valid-url",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toContain("dev-mock");
    expect(cfg.mode).toBe("dev-mock");
  });

  it("should drop an unparseable localstackEndpoint (= new URL throws) to undefined", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "https://api.example.com",
        mode: "backend",
        cloudMode: "localstack",
        // host 検査以前に `new URL()` が throw する不正値 → undefined に倒す (= fail closed)。
        localstackEndpoint: "http://",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.cloudMode).toBe("localstack");
    expect(cfg.localstackEndpoint).toBeUndefined();
  });

  it("should leave localstackEndpoint undefined when cloudMode=localstack but the key is omitted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "https://api.example.com",
        mode: "backend",
        cloudMode: "localstack",
        // localstackEndpoint 未指定 (= 非 string) → normalizeLocalstackEndpoint 早期 return。
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.cloudMode).toBe("localstack");
    expect(cfg.localstackEndpoint).toBeUndefined();
  });

  it("should fall back apiBaseUrl to the dev default when the key is omitted (dev-mock mode)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      // apiBaseUrl を省いた dev-mock 配信 → `?? DEV_FALLBACK.apiBaseUrl` で既定値を採用。
      json: async () => ({ eventTitle: "No-API Event" }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toBe("http://localhost:3199/dev-mock");
    expect(cfg.mode).toBe("dev-mock");
    expect(cfg.eventTitle).toBe("No-API Event");
  });

  // #1420: coordination dispatcher URL の parse + HTTPS gate。
  it("should carry an HTTPS coordinationApiUrl in backend mode", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "https://api.example.com",
        mode: "backend",
        coordinationApiUrl: "https://coord.example.com",
      }),
    });
    expect((await loadConfig()).coordinationApiUrl).toBe("https://coord.example.com");
  });

  it("should drop a non-HTTPS coordinationApiUrl in backend mode but keep the portal usable", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "https://api.example.com",
        mode: "backend",
        coordinationApiUrl: "http://coord.example.com",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.coordinationApiUrl).toBeUndefined();
    expect(cfg.apiBaseUrl).toBe("https://api.example.com");
  });

  it("should allow a non-HTTPS coordinationApiUrl in dev-mock mode", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ mode: "dev-mock", coordinationApiUrl: "http://localhost:9100" }),
    });
    expect((await loadConfig()).coordinationApiUrl).toBe("http://localhost:9100");
  });

  it("should leave coordinationApiUrl undefined when the key is omitted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ apiBaseUrl: "https://api.example.com", mode: "backend" }),
    });
    expect((await loadConfig()).coordinationApiUrl).toBeUndefined();
  });
});
