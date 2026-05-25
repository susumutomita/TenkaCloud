import { describe, expect, it } from "vitest";
import { describeAjvError } from "../../../scripts/validate-problems";

/**
 * Issue #1347: Ajv の raw error を author-friendly な hint に変換するロジックを pin する。
 *
 * `scripts/validate-problems.ts` の `describeAjvError` は Ajv の keyword / params から
 * `必須 field "X" がありません` / `有効値は ...` 等の具体的指示を派生させる。
 * 想定外 keyword は元の message を素通す (= regression を作らない)。
 */
describe("describeAjvError (#1347)", () => {
  it("should turn 'required' into a 'add this missing field' message", () => {
    const msg = describeAjvError({
      keyword: "required",
      instancePath: "/scoring",
      params: { missingProperty: "kind" },
      message: "must have required property 'kind'",
      schemaPath: "#/required",
    });
    expect(msg).toContain('"kind"');
    expect(msg).toContain("必須 field");
    expect(msg).toContain("/scoring");
  });

  it("should turn 'enum' into a 'choose one of these allowed values' message", () => {
    const msg = describeAjvError({
      keyword: "enum",
      instancePath: "/scoring/kind",
      params: {
        allowedValues: [
          "flag",
          "uptime-flat",
          "uptime-multi",
          "phased-polling",
          "attack-detection",
        ],
      },
      message: "must be equal to one of the allowed values",
      schemaPath: "#/properties/scoring/properties/kind/enum",
    });
    expect(msg).toContain("有効値は");
    expect(msg).toContain('"flag"');
    expect(msg).toContain('"attack-detection"');
  });

  it("should turn 'type' into a 'wrong type' message", () => {
    const msg = describeAjvError({
      keyword: "type",
      instancePath: "/scoring/points",
      params: { type: "number" },
      message: "must be number",
      schemaPath: "#/properties/scoring/properties/points/type",
    });
    expect(msg).toContain("number");
    expect(msg).toContain("/scoring/points");
  });

  it("should turn 'additionalProperties' into a 'unknown field' message", () => {
    const msg = describeAjvError({
      keyword: "additionalProperties",
      instancePath: "/scoring",
      params: { additionalProperty: "typoField" },
      message: "must NOT have additional properties",
      schemaPath: "#/properties/scoring/additionalProperties",
    });
    expect(msg).toContain("typoField");
    expect(msg).toContain("未知の field");
  });

  it("should default to passing through the Ajv message for unknown keywords", () => {
    const msg = describeAjvError({
      keyword: "format" as never,
      instancePath: "/whatever",
      params: { format: "uri" },
      message: 'must match format "uri"',
      schemaPath: "#/properties/whatever/format",
    });
    expect(msg).toContain("must match format");
  });
});
