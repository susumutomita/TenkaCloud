import { describe, expect, it } from "vitest";
import { handlerNoDirectSdkImport } from "./handler-no-direct-sdk-import.ts";

describe("handler-no-direct-sdk-import", () => {
  it("handler/index.ts での @aws-sdk/client-* import を warning にすべき", () => {
    const code = [
      'import { CloudFormationClient } from "@aws-sdk/client-cloudformation";',
      'import { Hono } from "hono";',
    ].join("\n");
    const findings = handlerNoDirectSdkImport.check({
      files: ["infrastructure/lib/foo/handlers/bar/index.ts"],
      readFile: () => code,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("handler-no-direct-sdk-import");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.match).toBe("@aws-sdk/client-cloudformation");
  });

  it("@aws-sdk/lib-* import も warning にすべき", () => {
    const code = 'import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";';
    const findings = handlerNoDirectSdkImport.check({
      files: ["infrastructure/lib/foo/handlers/bar/index.ts"],
      readFile: () => code,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.match).toBe("@aws-sdk/lib-dynamodb");
  });

  it("非 SDK package の import は通すべき", () => {
    const code = 'import { Hono } from "hono";\nimport { StatusCodes } from "http-status-codes";';
    const findings = handlerNoDirectSdkImport.check({
      files: ["infrastructure/lib/foo/handlers/bar/index.ts"],
      readFile: () => code,
    });

    expect(findings).toHaveLength(0);
  });

  it("handler/<name>/service.ts は対象外にすべき (= 非 index.ts は service / repository 層)", () => {
    const code = 'import { CloudFormationClient } from "@aws-sdk/client-cloudformation";';
    const findings = handlerNoDirectSdkImport.check({
      files: ["infrastructure/lib/foo/handlers/bar/service.ts"],
      readFile: () => code,
    });

    expect(findings).toHaveLength(0);
  });

  it("infrastructure/lib/ 外は対象外にすべき", () => {
    const code = 'import { CloudFormationClient } from "@aws-sdk/client-cloudformation";';
    const findings = handlerNoDirectSdkImport.check({
      files: ["apps/admin-console/src/handlers/foo/index.ts"],
      readFile: () => code,
    });

    expect(findings).toHaveLength(0);
  });

  it("handlers/ を path に含まない infrastructure/lib/ の index.ts は対象外にすべき", () => {
    const code = 'import { CloudFormationClient } from "@aws-sdk/client-cloudformation";';
    const findings = handlerNoDirectSdkImport.check({
      files: ["infrastructure/lib/control-plane-stack.ts"],
      readFile: () => code,
    });

    expect(findings).toHaveLength(0);
  });

  it("複数 SDK import は別 finding として並べるべき", () => {
    const code = [
      'import { CloudFormationClient } from "@aws-sdk/client-cloudformation";',
      'import { SSMClient } from "@aws-sdk/client-ssm";',
      'import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";',
    ].join("\n");
    const findings = handlerNoDirectSdkImport.check({
      files: ["infrastructure/lib/foo/handlers/bar/index.ts"],
      readFile: () => code,
    });

    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.match)).toEqual([
      "@aws-sdk/client-cloudformation",
      "@aws-sdk/client-ssm",
      "@aws-sdk/lib-dynamodb",
    ]);
  });
});
