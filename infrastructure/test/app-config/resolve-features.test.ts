import { describe, expect, it } from "vitest";
import { resolveFeatures } from "../../lib/app-config/resolve";

/**
 * Issue #2230: `CDK_PARAM_FEATURES` (JSON) → AppConfig.features の解決を pin する。
 * SPA 側の `resolveFeatureFlags` は tolerant (未知 key / 非 boolean を無視) だが、 deploy 入力の
 * 誤りは synth で fail loudly させる (= 壊れた値を runtime-config.json まで持ち越さない)。
 */
describe("resolveFeatures (issue #2230)", () => {
  it("should return undefined when CDK_PARAM_FEATURES is unset or blank (= features key omitted)", () => {
    expect(resolveFeatures({})).toBeUndefined();
    expect(resolveFeatures({ CDK_PARAM_FEATURES: "" })).toBeUndefined();
    expect(resolveFeatures({ CDK_PARAM_FEATURES: "   " })).toBeUndefined();
  });

  it("should parse a boolean map", () => {
    expect(
      resolveFeatures({ CDK_PARAM_FEATURES: '{"nonAwsRuntime":true,"samlSso":false}' }),
    ).toEqual({
      nonAwsRuntime: true,
      samlSso: false,
    });
  });

  it("should fail loudly on invalid JSON", () => {
    expect(() => resolveFeatures({ CDK_PARAM_FEATURES: "not-json" })).toThrow(
      /CDK_PARAM_FEATURES は JSON object/,
    );
  });

  it("should fail loudly on non-object JSON (array / string / null)", () => {
    for (const raw of ['["nonAwsRuntime"]', '"nonAwsRuntime"', "null"]) {
      expect(() => resolveFeatures({ CDK_PARAM_FEATURES: raw })).toThrow(
        /CDK_PARAM_FEATURES は JSON object/,
      );
    }
  });

  it("should fail loudly on non-boolean values (= config typo caught at synth)", () => {
    expect(() => resolveFeatures({ CDK_PARAM_FEATURES: '{"nonAwsRuntime":"true"}' })).toThrow(
      /"nonAwsRuntime" は boolean/,
    );
  });
});
