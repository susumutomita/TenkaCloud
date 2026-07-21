import { describe, expect, it } from "vitest";
import { synthWithControlDataBackendTurso } from "../problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2739: pure Turso intentionally synthesizes no control-data DynamoDB tables.
 * The GenericScoring Lambda must still receive the backend-independent scheduled-action
 * inputs and retain its least-privilege PutEvents grant.
 */

describe("GenericScoring scheduled actions on pure Turso synth (#2739)", () => {
  const template = synthWithControlDataBackendTurso();

  function findGenericScoringFunction(): Record<string, unknown> {
    const functions = template.findResources("AWS::Lambda::Function");
    const entry = Object.entries(functions).find(
      ([logicalId]) => logicalId.includes("GenericScoring") && logicalId.includes("Function"),
    );
    expect(entry).toBeDefined();
    return (entry?.[1] ?? {}) as Record<string, unknown>;
  }

  it("should provide Turso, event-bus, and environment inputs without DynamoDB table names", () => {
    const genericScoring = findGenericScoringFunction() as {
      Properties?: { Environment?: { Variables?: Record<string, unknown> } };
    };
    const variables = genericScoring.Properties?.Environment?.Variables ?? {};

    expect(variables.CONTROL_DATA_BACKEND).toBe("turso");
    expect(variables.DEPLOY_EVENT_BUS_NAME).toBeDefined();
    expect(variables.DEPLOY_ENVIRONMENT).toBe("development");
    expect(variables.TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
    expect(variables.TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe(
      "/tenkacloud/development/turso-token",
    );
    expect(variables.EVENTS_TABLE_NAME).toBeUndefined();
    expect(variables.DEPLOYMENTS_TABLE_NAME).toBeUndefined();
    expect(variables.TEAMS_TABLE_NAME).toBeUndefined();
    expect(variables.COMPETITOR_ACCOUNTS_TABLE_NAME).toBeUndefined();
  });

  it("should retain events:PutEvents scoped to the deploy event bus", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const genericScoringPolicy = Object.entries(policies).find(
      ([logicalId]) =>
        logicalId.includes("GenericScoring") &&
        logicalId.includes("ServiceRole") &&
        logicalId.includes("DefaultPolicy"),
    );
    expect(genericScoringPolicy).toBeDefined();

    const statements =
      (
        genericScoringPolicy?.[1] as {
          Properties?: { PolicyDocument?: { Statement?: readonly Record<string, unknown>[] } };
        }
      )?.Properties?.PolicyDocument?.Statement ?? [];
    const putEventsStatement = statements.find((statement) => {
      const action = statement.Action as string | readonly string[] | undefined;
      return Array.isArray(action)
        ? action.includes("events:PutEvents")
        : action === "events:PutEvents";
    });

    expect(putEventsStatement).toBeDefined();
    expect(JSON.stringify(putEventsStatement?.Resource)).toContain(
      "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    );
  });
});
