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

  it("/runtime-config.json が 200 で返ったら値を取り出すべき", async () => {
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
  });

  it("mode が runtime-config に無いときは fallback の dev-mock になるべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ apiBaseUrl: "https://api.example.com" }),
    });
    const cfg = await loadConfig();
    expect(cfg.mode).toBe("dev-mock");
  });

  it("一部キー欠落でも fallback で埋めるべき", async () => {
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

  it("404 のときは fallback を返すべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toContain("dev-mock");
  });

  it("fetch が throw したら fallback を返すべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    const cfg = await loadConfig();
    expect(cfg.apiBaseUrl).toContain("dev-mock");
  });

  it("Issue #871: backend mode で apiBaseUrl が http:// なら fallback に倒れるべき", async () => {
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
  });
});
