import { describe, expect, it } from "vitest";
import {
  asUptimeScoring,
  joinUrl,
  parseScoringMap,
} from "../../lib/problem-deploy/handlers/health-check-handler";

/**
 * Health Check Lambda 内部のヘルパー (純粋関数) を単体テストで固める。
 * Lambda handler 自体 (DDB Scan + 並列 probe) は実 fetch / DDB の integration テスト
 * 経路で確認する想定で、ここでは scoring の解釈と URL 生成だけを pin する。
 */

describe("parseScoringMap", () => {
  it("env 未設定なら空 map を返すべき", () => {
    delete process.env.BATTLE_PROBLEMS_SCORING;
    expect(parseScoringMap()).toEqual({});
  });
  it("正常な JSON object はそのまま返すべき", () => {
    process.env.BATTLE_PROBLEMS_SCORING = JSON.stringify({
      "p-1": { kind: "uptime", endpoints: [], pointsPerSuccess: 50 },
    });
    expect(parseScoringMap()).toEqual({
      "p-1": { kind: "uptime", endpoints: [], pointsPerSuccess: 50 },
    });
  });
  it("array や primitive は空 map を返すべき", () => {
    process.env.BATTLE_PROBLEMS_SCORING = JSON.stringify(["x"]);
    expect(parseScoringMap()).toEqual({});
    process.env.BATTLE_PROBLEMS_SCORING = JSON.stringify(123);
    expect(parseScoringMap()).toEqual({});
  });
  it("壊れた JSON は空 map を返すべき", () => {
    process.env.BATTLE_PROBLEMS_SCORING = "{not-json";
    expect(parseScoringMap()).toEqual({});
  });
});

describe("asUptimeScoring", () => {
  it("kind=uptime + pointsPerSuccess + endpoints が揃っていれば返すべき", () => {
    const cfg = {
      kind: "uptime",
      endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
      pointsPerSuccess: 100,
    };
    expect(asUptimeScoring(cfg)).toEqual(cfg);
  });

  it("kind=flag は uptime として認識しない", () => {
    expect(asUptimeScoring({ kind: "flag", flagOutputKey: "X", points: 100 })).toBeUndefined();
  });

  it("endpoints が array でない / pointsPerSuccess が無いと undefined を返すべき", () => {
    expect(asUptimeScoring({ kind: "uptime", pointsPerSuccess: 50 })).toBeUndefined();
    expect(asUptimeScoring({ kind: "uptime", endpoints: [] })).toBeUndefined();
  });

  it("primitive / null は undefined を返すべき", () => {
    expect(asUptimeScoring(null)).toBeUndefined();
    expect(asUptimeScoring(123)).toBeUndefined();
    expect(asUptimeScoring("uptime")).toBeUndefined();
  });
});

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
