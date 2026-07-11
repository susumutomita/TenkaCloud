import { describe, expect, it } from "vitest";
import { domainNoInfraImport } from "./domain-no-infra-import.ts";

const DOMAIN = "infrastructure/lib/problem-deploy/control-data/domain/deployments.ts";

describe("domain-no-infra-import", () => {
  it("should flag an AWS SDK import inside a domain module as error", () => {
    const code = 'import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";';
    const findings = domainNoInfraImport.check({
      files: [DOMAIN],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("domain-no-infra-import");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.match).toBe("@aws-sdk/lib-dynamodb");
  });

  it("should flag an escape to the adapter layer (any ../ specifier)", () => {
    const code = 'import { createSqlExecutorCache } from "../sql-executor-cache.js";';
    const findings = domainNoInfraImport.check({
      files: [DOMAIN],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.match).toBe("../sql-executor-cache.js");
  });

  it("should flag a handler-layer import even when deeply qualified", () => {
    const code = 'import { writeAuditEvent } from "../../handlers/shared/audit-log.js";';
    const findings = domainNoInfraImport.check({
      files: [DOMAIN],
      readFile: () => code,
    });
    expect(findings).toHaveLength(1);
  });

  it("should flag a CDK import (aws-cdk-lib / constructs)", () => {
    const code =
      'import { Stack } from "aws-cdk-lib";\nimport type { Construct } from "constructs";';
    const findings = domainNoInfraImport.check({
      files: [DOMAIN],
      readFile: () => code,
    });
    expect(findings).toHaveLength(2);
  });

  it("should allow sibling domain imports and pure workspace packages", () => {
    const code = [
      'import type { DeploymentRecord } from "./deployments.js";',
      'import type { SamlIdpConfig } from "@tenkacloud/saml-utils";',
    ].join("\n");
    const findings = domainNoInfraImport.check({
      files: ["infrastructure/lib/problem-deploy/control-data/domain/saml-idps.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("should ignore files outside the domain layer", () => {
    const code = 'import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";';
    const findings = domainNoInfraImport.check({
      files: ["infrastructure/lib/problem-deploy/control-data/dynamodb-events-repository.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });

  it("should not flag a commented-out import", () => {
    const code = '// import { Stack } from "aws-cdk-lib";';
    const findings = domainNoInfraImport.check({
      files: [DOMAIN],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });
});
