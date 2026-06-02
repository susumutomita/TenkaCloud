import { ParameterNotFound } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import {
  isParameterNotFound,
  isParameterVersionNotFound,
} from "../../lib/problem-deploy/handlers/shared/ssm-parameter.js";

/**
 * shared SSM not-found 判定 helper の pin。 ExternalId store / Sakura key store が共有する
 * (= class instance / err.name 文字列 両方の SDK 挙動を吸収する) ことを保証する。
 */
describe("ssm-parameter helpers", () => {
  it("should detect ParameterNotFound as a class instance", () => {
    expect(isParameterNotFound(new ParameterNotFound({ message: "x", $metadata: {} }))).toBe(true);
  });

  it("should detect ParameterNotFound by err.name (SDK/version variance)", () => {
    expect(isParameterNotFound(Object.assign(new Error("x"), { name: "ParameterNotFound" }))).toBe(
      true,
    );
  });

  it("should not flag unrelated errors or non-errors as ParameterNotFound", () => {
    expect(isParameterNotFound(new Error("throttled"))).toBe(false);
    expect(isParameterNotFound("ParameterNotFound")).toBe(false);
    expect(isParameterNotFound(undefined)).toBe(false);
  });

  it("should detect ParameterVersionNotFound by err.name", () => {
    expect(
      isParameterVersionNotFound(
        Object.assign(new Error("x"), { name: "ParameterVersionNotFound" }),
      ),
    ).toBe(true);
  });

  it("should not flag unrelated errors as ParameterVersionNotFound", () => {
    expect(isParameterVersionNotFound(new Error("ParameterNotFound"))).toBe(false);
    expect(isParameterVersionNotFound(null)).toBe(false);
  });
});
