import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeLargeEnvValue } from "../lib/utils/env-encoding";

/**
 * Issue #810: 保存済み gzip+base64 環境値の decoder 互換性を確認。
 *
 * 重要な要件:
 *   - roundtrip で同じ JSON が返る
 *   - 旧形式 (= plain JSON) を decode するときは そのまま返す (backward compat)
 *   - undefined / 空文字は そのまま返す (= caller の fallback 経路を維持)
 *   - 壊れた base64 / truncated input は raw を返して JSON parse fail に任せる
 */

describe("decodeLargeEnvValue (#810)", () => {
  it("should decode a saved gzip/base64 JSON value", () => {
    const original = JSON.stringify({
      "hello-world": { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
    const encoded = gzipSync(original).toString("base64");
    const decoded = decodeLargeEnvValue(encoded);
    expect(decoded).toBe(original);
  });

  it("should decode gzip/base64 JSON containing Japanese text", () => {
    const original = JSON.stringify({
      "hello-world": {
        description: "AWS Console から SSM Parameter Store にアクセスして値を読む問題",
      },
    });
    const encoded = gzipSync(original).toString("base64");
    expect(decodeLargeEnvValue(encoded)).toBe(original);
  });

  it("should return plain JSON (legacy format / test fixture) without decoding (backward compat)", () => {
    const plain = '{"hello-world":{"kind":"flag","points":100}}';
    expect(decodeLargeEnvValue(plain)).toBe(plain);
  });

  it("should return undefined as-is (preserve caller fallback)", () => {
    expect(decodeLargeEnvValue(undefined)).toBeUndefined();
  });

  it("should return empty string as-is", () => {
    expect(decodeLargeEnvValue("")).toBe("");
  });

  it("should return raw on broken base64 (H4s prefix but decode fails) and let caller fall back to JSON parse", () => {
    const broken = "H4sIINVALID==";
    // decode は raw を返す → 上位 parser が JSON.parse で fail → 空 map fallback
    expect(decodeLargeEnvValue(broken)).toBe(broken);
  });

  it("should decode saved scoring metadata for multiple problem kinds", () => {
    const big = JSON.stringify({
      "hello-world": {
        kind: "flag",
        flagOutputKey: "P",
        points: 100,
        hints: [{ id: "h1", content: "ヒント 1", penalty: 5 }],
      },
      "uptime-mock": {
        kind: "uptime-flat",
        endpoints: [{ slot: "main", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
      "phased-mock": {
        kind: "phased-polling",
        intervalMinutes: 1,
        probe: { metaPath: "/meta", scorePath: "/score" },
        platformRules: { ec2: { points: 100 } },
      },
    });
    expect(decodeLargeEnvValue(gzipSync(big).toString("base64"))).toBe(big);
  });
});
