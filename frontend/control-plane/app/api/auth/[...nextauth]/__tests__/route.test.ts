import { describe, expect, it, vi } from "vitest";

// auth モジュールのモック
vi.mock("@/auth", () => ({
  handlers: {
    GET: vi.fn(),
    POST: vi.fn(),
  },
}));

describe("Auth API Route", () => {
  it("GET と POST ハンドラーをエクスポートすべき", async () => {
    // 動的インポートで実際のルートファイルをテスト
    const { GET, POST } = await import("../route");

    expect(GET).toBeDefined();
    expect(POST).toBeDefined();
    expect(typeof GET).toBe("function");
    expect(typeof POST).toBe("function");
  });
});
