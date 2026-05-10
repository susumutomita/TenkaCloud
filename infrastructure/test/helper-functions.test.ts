import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnv, getOptionalEnv } from "../lib/helper-functions";

const TEST_ENV = "TENKACLOUD_HELPER_TEST_ENV";

beforeEach(() => {
  delete process.env[TEST_ENV];
});
afterEach(() => {
  delete process.env[TEST_ENV];
});

describe("getEnv", () => {
  it("env が set されていれば値を返すべき", () => {
    process.env[TEST_ENV] = "value-1";
    expect(getEnv(TEST_ENV)).toBe("value-1");
  });

  it("env が未設定なら throw するべき (= Lambda init で fail-fast、設定漏れを silent 通過させない)", () => {
    expect(() => getEnv(TEST_ENV)).toThrow(`${TEST_ENV} is empty`);
  });

  it("env が空文字なら throw するべき (= 設定漏れ扱い)", () => {
    process.env[TEST_ENV] = "";
    expect(() => getEnv(TEST_ENV)).toThrow(`${TEST_ENV} is empty`);
  });
});

describe("getOptionalEnv", () => {
  it("env が set されていれば値を返すべき", () => {
    process.env[TEST_ENV] = "value-1";
    expect(getOptionalEnv(TEST_ENV)).toBe("value-1");
  });

  it("env が未設定なら undefined を返すべき (throw しない、Lambda init を生かす)", () => {
    expect(getOptionalEnv(TEST_ENV)).toBeUndefined();
  });

  it("env が空文字なら undefined を返すべき (= 未設定と同義)", () => {
    process.env[TEST_ENV] = "";
    expect(getOptionalEnv(TEST_ENV)).toBeUndefined();
  });
});
