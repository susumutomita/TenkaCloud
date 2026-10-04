import { expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthParticipantPortalLambdaOnly,
} from "../../problem-deploy-backend-stack.test-helpers";

it(
  "keeps current deployment verification for team login and SSO",
  () => {
    const template = synthParticipantPortalLambdaOnly();
    const env = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((resource) => resource.Properties.Environment?.Variables)
      .find((variables) => variables?.DEPLOYMENTS_TABLE_NAME);
    const tableId = env?.DEPLOYMENTS_TABLE_NAME?.Ref;
    expect(tableId).toEqual(expect.any(String));
    const policies = Object.values(template.findResources("AWS::IAM::Role")).flatMap(
      (role) => role.Properties.Policies ?? [],
    );
    const deploymentsRead = policies.find((policy) => policy.PolicyName === "DeploymentsRead");
    expect(deploymentsRead).toBeDefined();
    const primaryReads = deploymentsRead.PolicyDocument.Statement.filter(
      (statement: { Action: string | string[] }) =>
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
          "dynamodb:GetItem",
        ),
    );
    expect(primaryReads).toEqual([
      {
        Action: "dynamodb:GetItem",
        Effect: "Allow",
        Resource: { "Fn::GetAtt": [tableId, "Arn"] },
      },
    ]);
  },
  SYNTH_TIMEOUT_MS,
);

it(
  "removes self-registration permissions while preserving ordinary event reads",
  () => {
    const template = synthParticipantPortalLambdaOnly();
    const policies = Object.values(template.findResources("AWS::IAM::Role")).flatMap(
      (role) => role.Properties.Policies ?? [],
    );
    expect(policies.map((policy) => policy.PolicyName)).not.toContain("RegistrationTeamsRead");
    expect(policies.map((policy) => policy.PolicyName)).not.toContain("RegistrationClaims");
    const eventsRead = policies.find((policy) => policy.PolicyName === "EventsRead");
    expect(eventsRead?.PolicyDocument.Statement).toEqual([
      expect.objectContaining({
        Action: ["dynamodb:Query", "dynamodb:GetItem"],
        Effect: "Allow",
      }),
    ]);
    const environments = Object.values(template.findResources("AWS::Lambda::Function")).map(
      (resource) => resource.Properties.Environment?.Variables,
    );
    expect(environments.some((env) => env?.DEPLOYMENTS_TABLE_NAME && env?.EVENTS_TABLE_NAME)).toBe(
      true,
    );
    expect(environments.every((env) => !env?.TEAMS_TABLE_NAME)).toBe(true);
  },
  SYNTH_TIMEOUT_MS,
);
