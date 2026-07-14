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

  it("should load runtime-config with cloudMode=local over a loopback HTTP apiBaseUrl", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "http://127.0.0.1:3199",
        eventTitle: "TenkaCloud Local",
        eventRegion: "local",
        mode: "backend",
        cloudMode: "local",
        localTeamLoginKey: "local-team-key",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.mode).toBe("backend");
    expect(cfg.cloudMode).toBe("local");
    expect(cfg.apiBaseUrl).toBe("http://127.0.0.1:3199");
    expect(cfg.localTeamLoginKey).toBe("local-team-key");
  });

  it("should fall back when cloudMode=local but apiBaseUrl is non-loopback HTTP", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "http://api.example.com",
        mode: "backend",
        cloudMode: "local",
      }),
    });
    const cfg = await loadConfig();
    // #871 guard: non-loopback HTTP in backend mode collapses to the dev fallback.
    expect(cfg.mode).toBe("dev-mock");
  });

  it("should fill missing keys with fallbacks", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ apiBaseUrl: "https://x.example/api" }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toBe("https://x.example/api");
    // 他キーは fallback
    expect(cfg.eventTitle).toBe("TenkaCloud Battle Demo");
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

  // Issue #1975: local self-paced mode は backend を loopback http で立てる。 loopback だけは
  // 同一マシン内で外部に出ず bearer 漏洩経路にならないため、 backend mode でも例外的に許容する。
  it("Issue #1975: should allow http://127.0.0.1 loopback apiBaseUrl in backend mode", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "http://127.0.0.1:3199",
        eventTitle: "Local Self-Paced",
        eventRegion: "ap-northeast-1",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toBe("http://127.0.0.1:3199");
    expect(cfg.mode).toBe("backend");
    expect(cfg.cloudMode).toBe("real");
  });

  it("Issue #1975: should allow http://localhost loopback apiBaseUrl in backend mode", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "http://localhost:5175",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toBe("http://localhost:5175");
    expect(cfg.mode).toBe("backend");
  });

  it("Issue #1975: should allow http://[::1] loopback apiBaseUrl in backend mode", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "http://[::1]:3199",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toBe("http://[::1]:3199");
    expect(cfg.mode).toBe("backend");
  });

  it("Issue #1975: should still reject non-loopback http apiBaseUrl in backend mode", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        // http かつ非 loopback (= hostname が loopback いずれにも一致しない) → 依然 fallback。
        apiBaseUrl: "http://evil.example.com",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toContain("dev-mock");
    expect(cfg.mode).toBe("dev-mock");
  });

  it("Issue #1975: should allow an HTTPS apiBaseUrl in backend mode (loopback gate not reached)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        apiBaseUrl: "https://real.example.com",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toBe("https://real.example.com");
    expect(cfg.mode).toBe("backend");
  });

  it("Issue #1975: should reject a non-http loopback scheme in backend mode (protocol guard)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        // 解析可能だが http: でも https: でもない (= ftp:) loopback。 isHttpsUrl が false の後
        // isLoopbackHttpUrl の `protocol !== "http:"` 早期 return (= false) を踏ませて fallback。
        apiBaseUrl: "ftp://localhost:3199",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toContain("dev-mock");
    expect(cfg.mode).toBe("dev-mock");
  });

  it("Issue #1975: should fall back when apiBaseUrl is unparseable in backend mode (loopback catch)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        // isHttpsUrl が false の後 isLoopbackHttpUrl が呼ばれ、 `new URL()` が throw して
        // try/catch が false を返す → fallback に倒す (= fail closed)。
        apiBaseUrl: "ht!tp://%%%",
        mode: "backend",
      }),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toContain("dev-mock");
    expect(cfg.mode).toBe("dev-mock");
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
