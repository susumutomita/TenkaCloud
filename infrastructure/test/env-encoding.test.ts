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
  it("encode → decode で元の JSON 文字列を復元すべき", () => {
    const original = JSON.stringify({
      "hello-world": { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
    const encoded = encodeLargeEnvValue(original);
    const decoded = decodeLargeEnvValue(encoded);
    expect(decoded).toBe(original);
  });

  it("UTF-8 multibyte (JA description) を含む JSON も roundtrip すべき", () => {
    const original = JSON.stringify({
      "hello-world": {
        description: "AWS Console から SSM Parameter Store にアクセスして値を読む問題",
      },
    });
    const encoded = encodeLargeEnvValue(original);
    expect(decodeLargeEnvValue(encoded)).toBe(original);
  });

  it("encode 結果は base64 で gzip magic (H4s) を prefix に持つべき", () => {
    const encoded = encodeLargeEnvValue('{"a":1}');
    expect(encoded.startsWith("H4s")).toBe(true);
  });

  it("plain JSON (= 旧形式 / test fixture) は decode せずそのまま返すべき (backward compat)", () => {
    const plain = '{"hello-world":{"kind":"flag","points":100}}';
    expect(decodeLargeEnvValue(plain)).toBe(plain);
  });

  it("undefined は undefined のまま返すべき (= caller の fallback を維持)", () => {
    expect(decodeLargeEnvValue(undefined)).toBeUndefined();
  });

  it("空文字は 空文字 のまま返すべき", () => {
    expect(decodeLargeEnvValue("")).toBe("");
  });

  it("壊れた base64 (= H4s 始まりだが decode 失敗) は raw を返し caller の JSON parse fallback に任せるべき", () => {
    const broken = "H4sIINVALID==";
    // decode は raw を返す → 上位 parser が JSON.parse で fail → 空 map fallback
    expect(decodeLargeEnvValue(broken)).toBe(broken);
  });

  it("実際の問題 metadata (= 5 kind 全部入り) も roundtrip すべき", () => {
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

  it("圧縮率: JA description 込み 1000+ bytes JSON で encode 後サイズが原文より小さくなるべき", () => {
    const verbose = JSON.stringify({
      p1: { description: "あ".repeat(500), kind: "flag" },
      p2: { description: "い".repeat(500), kind: "flag" },
    });
    const encoded = encodeLargeEnvValue(verbose);
    expect(encoded.length).toBeLessThan(verbose.length);
  });
});
