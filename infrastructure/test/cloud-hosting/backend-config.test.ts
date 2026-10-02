import { describe, expect, it } from "vitest";
import { cloudControlDataConfiguration } from "../../lib/cloud-hosting/config.js";

describe("cloud deployment database configuration", () => {
  it.each([undefined, "", " ", "DynamoDB", " dynamodb "])(
    "keeps original Dynamo default for %s",
    (value) => {
      expect(cloudControlDataConfiguration({ CDK_PARAM_CONTROL_DATA_BACKEND: value })).toEqual({
        kind: "dynamodb",
      });
    },
  );
  it("normalizes the original Turso choice and libsql URL for secure HTTP execution", () => {
    expect(
      cloudControlDataConfiguration({
        CDK_PARAM_CONTROL_DATA_BACKEND: " TURSO ",
        CDK_PARAM_TURSO_DATABASE_URL: " libsql://example.turso.io ",
        CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: " /TenkaCloud/test/turso/auth-token ",
      }),
    ).toEqual({
      kind: "turso",
      databaseUrl: "https://example.turso.io",
      authTokenParameterName: "/TenkaCloud/test/turso/auth-token",
    });
  });
  it.each(["sqlite", "sql", "turso-mirror"])("rejects unsupported backend %s", (kind) => {
    expect(() => cloudControlDataConfiguration({ CDK_PARAM_CONTROL_DATA_BACKEND: kind })).toThrow(
      "dynamodb|turso",
    );
  });
  it.each([
    undefined,
    "",
    "file:/tmp/local.db",
    "http://example.test",
    "https://token@example.test",
    "https://example.test?authToken=secret",
    "https://example.test/#secret",
    "https://example.test/path",
  ])("rejects missing or unsafe Turso database URLs", (url) => {
    expect(() =>
      cloudControlDataConfiguration({
        CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
        CDK_PARAM_TURSO_DATABASE_URL: url,
        CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/token",
      }),
    ).toThrow();
  });
  it.each([
    undefined,
    "",
    "/",
    "/TenkaCloud/*",
    "arn:aws:ssm:us-east-1:123456789012:parameter/token",
    "/aws/token",
  ])("rejects missing or broad token parameter identities", (parameter) => {
    expect(() =>
      cloudControlDataConfiguration({
        CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
        CDK_PARAM_TURSO_DATABASE_URL: "https://example.turso.io",
        CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: parameter,
      }),
    ).toThrow();
  });
});
