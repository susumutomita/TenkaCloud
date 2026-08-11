import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { synthDefault } from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack (MVP-1) — DDB tables", () => {
  const tpl = synthDefault();

  it("should provision 7 DDB tables (Deployments / Events / Teams / CompetitorAccounts / ProblemEndpoints / Disruptions / AdminAuditLog) each with PK/SK and PROVISIONED 1/1", () => {
    // Events / Teams に加え、Issue #459 で CompetitorAccounts、
    // ProblemEndpoints、Issue #888 で Disruptions (Red Team audit + idempotency)、
    // Issue #950 で AdminAuditLog (admin 操作監査)。
    // 7 Table すべて DynamoDbLowCapacity Aspect で 1/1 PROVISIONED に均される。
    // (Issue #1312 SamlIdps は cross-stack cyclic dependency 回避のため TenkaCloudLiteStack に同居。)
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

  it("should keep exactly GSI1 on the Teams table — the plaintext login-key GSI2 is deleted (#2674)", () => {
    // #2674: the Teams GSI2 (`GSI2PK = TEAMKEY#<plaintext>`) had zero readers —
    // participant auth queries the DEPLOYMENTS table's GSI2 — so it was removed.
    // Pin the shape so the plaintext bearer can never silently become an index
    // key on Teams again.
    const tables = tpl.findResources("AWS::DynamoDB::Table");
    const teams = Object.entries(tables).find(([logicalId]) => logicalId.includes("TeamsTable"));
    if (!teams) throw new Error("Teams table not found in the synthesized template");
    const props = (
      teams[1] as {
        Properties: { GlobalSecondaryIndexes?: readonly { IndexName: string }[] };
      }
    ).Properties;
    expect(props.GlobalSecondaryIndexes?.map((gsi) => gsi.IndexName)).toEqual(["GSI1"]);
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
