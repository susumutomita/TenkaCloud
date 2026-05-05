import { describe, expect, it } from "vitest";
import { joinUrl } from "../../lib/problem-deploy/handlers/health-check-handler";

/**
 * Health Check Lambda 内の URL helper を pin する。Scoring の解釈は
 * `lib/utils/scoring-metadata.ts` 側で集約され、別 test file が cover する。
 */

describe("joinUrl", () => {
  it("path 空ならそのまま base を返すべき", () => {
    expect(joinUrl("https://x.example.com", "")).toBe("https://x.example.com");
  });

  it("base 末尾 / と path 先頭 / の二重スラッシュを正規化", () => {
    expect(joinUrl("https://x.example.com/", "/foo")).toBe("https://x.example.com/foo");
  });

  it("base 末尾 / 無し + path 先頭 / 無しは / を補う", () => {
    expect(joinUrl("https://x.example.com", "foo")).toBe("https://x.example.com/foo");
  });

  it("path が絶対 URL ならそのまま採用 (= override)", () => {
    expect(joinUrl("https://x.example.com", "https://other.example.com/health")).toBe(
      "https://other.example.com/health",
    );
  });

  it("通常 case: 末尾 / 無し base + 先頭 / path", () => {
    expect(joinUrl("https://x.example.com", "/healthz")).toBe("https://x.example.com/healthz");
  });
});
