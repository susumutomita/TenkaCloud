import { describe, expect, it } from "vitest";
import { secretsManagerForbidden } from "./secrets-manager-forbidden.ts";

describe("secrets-manager-forbidden", () => {
  it("@aws-sdk/client-secrets-manager の import を error にすべき", () => {
    const code = 'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";';
    const findings = secretsManagerForbidden.check({
      files: ["infrastructure/lib/problem-deploy/handlers/foo/service.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("secrets-manager-forbidden");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.match).toBe("@aws-sdk/client-secrets-manager");
  });

  it("CDK の aws-cdk-lib/aws-secretsmanager construct import も error にすべき", () => {
    const code = 'import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";';
    const findings = secretsManagerForbidden.check({
      files: ["infrastructure/lib/control-plane-stack.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.match).toBe("aws-cdk-lib/aws-secretsmanager");
  });

  it("SSM (推奨経路) の import は通すべき", () => {
    const code = 'import { SSMClient } from "@aws-sdk/client-ssm";';
    const findings = secretsManagerForbidden.check({
      files: ["infrastructure/lib/problem-deploy/handlers/foo/service.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it('side-effect import (`import "..."`) もすり抜けさせない (レビュー指摘)', () => {
    const code = 'import "@aws-sdk/client-secrets-manager";';
    const findings = secretsManagerForbidden.check({
      files: ["infrastructure/lib/foo.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
  });

  it("require() 形式もすり抜けさせない", () => {
    const code = 'const sm = require("@aws-sdk/client-secrets-manager");';
    const findings = secretsManagerForbidden.check({
      files: ["scripts/foo.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
  });

  it("harness 自身のファイルは対象外にすべき (= 本ルールの定義が自己検知しない)", () => {
    const code = "const re = /from\\s+[\"']@aws-sdk\\/client-secrets-manager[\"']/;";
    const findings = secretsManagerForbidden.check({
      files: [".claude/harness/src/rules/secrets-manager-forbidden.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });
});
