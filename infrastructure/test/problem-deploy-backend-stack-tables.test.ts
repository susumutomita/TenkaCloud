import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { synthDefault } from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack (MVP-1) — DDB tables", () => {
  const tpl = synthDefault();

  it("should provision 7 DDB tables (Deployments / Events / Teams / CompetitorAccounts / ProblemEndpoints / Disruptions / AdminAuditLog) each with PK/SK and PROVISIONED 1/1", () => {
    // ADR-004 Phase 1 で Events / Teams、Issue #459 / ADR-002 Phase 2.1 で CompetitorAccounts、
    // ADR-012 Phase 3.A で ProblemEndpoints、 Issue #888 で Disruptions (Red Team audit + idempotency)、
    // Issue #950 (ADR-020 Phase D) で AdminAuditLog (admin 操作監査)。
    // 7 Table すべて DynamoDbLowCapacity Aspect で 1/1 PROVISIONED に均される。
    tpl.resourceCountIs("AWS::DynamoDB::Table", 7);
    tpl.hasResourceProperties(
      "AWS::DynamoDB::Table",
      Match.objectLike({
        ProvisionedThroughput: Match.objectLike({
          ReadCapacityUnits: 1,
          WriteCapacityUnits: 1,
        }),
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: "PK", KeyType: "HASH" }),
          Match.objectLike({ AttributeName: "SK", KeyType: "RANGE" }),
        ]),
      }),
    );
  });

  it("should enable TTL on expiresAt", () => {
    tpl.hasResourceProperties(
      "AWS::DynamoDB::Table",
      Match.objectLike({
        TimeToLiveSpecification: Match.objectLike({
          AttributeName: "expiresAt",
          Enabled: true,
        }),
      }),
    );
  });
});
