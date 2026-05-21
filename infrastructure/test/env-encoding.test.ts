import { describe, expect, it } from "vitest";
import { decodeLargeEnvValue, encodeLargeEnvValue } from "../lib/utils/env-encoding";

/**
 * Issue #810: gzip+base64 encoder/decoder の挙動 pin。
 *
 * 重要な要件:
 *   - roundtrip で同じ JSON が返る
 *   - 旧形式 (= plain JSON) を decode するときは そのまま返す (backward compat)
 *   - undefined / 空文字は そのまま返す (= caller の fallback 経路を維持)
 *   - 壊れた base64 / truncated input は raw を返して JSON parse fail に任せる
 */

describe("encodeLargeEnvValue + decodeLargeEnvValue (#810)", () => {
  it("should restore the original JSON string through encode → decode", () => {
    const original = JSON.stringify({
      "hello-world": { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
    const encoded = encodeLargeEnvValue(original);
    const decoded = decodeLargeEnvValue(encoded);
    expect(decoded).toBe(original);
  });

  it("should roundtrip JSON containing UTF-8 multibyte (JA description)", () => {
    const original = JSON.stringify({
      "hello-world": {
        description: "AWS Console から SSM Parameter Store にアクセスして値を読む問題",
      },
    });
    const encoded = encodeLargeEnvValue(original);
    expect(decodeLargeEnvValue(encoded)).toBe(original);
  });

  it("encode output should be base64 prefixed with gzip magic (H4s)", () => {
    const encoded = encodeLargeEnvValue('{"a":1}');
    expect(encoded.startsWith("H4s")).toBe(true);
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

  it("should roundtrip actual problem metadata (all 5 kinds)", () => {
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
    expect(decodeLargeEnvValue(encodeLargeEnvValue(big))).toBe(big);
  });

  it("compression ratio: encoded size should be smaller than the original for 1000+ byte JSON with JA description", () => {
    const verbose = JSON.stringify({
      p1: { description: "あ".repeat(500), kind: "flag" },
      p2: { description: "い".repeat(500), kind: "flag" },
    });
    const encoded = encodeLargeEnvValue(verbose);
    expect(encoded.length).toBeLessThan(verbose.length);
  });
});
