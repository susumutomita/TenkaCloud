import { Match } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthParticipantPortalLambdaOnly,
} from "../../problem-deploy-backend-stack.test-helpers";

it(
  "allows registration primary verification to GetItem only on the deployments table",
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
  "limits claims to event attributes and reads team keys without team mutation",
  () => {
    const template = synthParticipantPortalLambdaOnly();
    template.hasResourceProperties("AWS::IAM::Role", {
      Policies: Match.arrayWith([
        {
          PolicyName: "RegistrationTeamsRead",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              Match.objectLike({
                Action: "dynamodb:GetItem",
                Effect: "Allow",
                Resource: Match.anyValue(),
              }),
            ],
          },
        },
        {
          PolicyName: "RegistrationClaims",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              Match.objectLike({
                Action: "dynamodb:UpdateItem",
                Effect: "Allow",
                Condition: {
                  "ForAllValues:StringEquals": {
                    "dynamodb:Attributes": [
                      "PK",
                      "SK",
                      "tenantId",
                      "expiresAt",
                      "endsAt",
                      "status",
                      "registration",
                      "updatedAt",
                    ],
                  },
                },
              }),
            ],
          },
        },
      ]),
    });
    const env = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((r) => r.Properties.Environment?.Variables)
      .find((v) => v?.TEAMS_TABLE_NAME);
    expect(env?.TEAMS_TABLE_NAME).toBeDefined();
  },
  SYNTH_TIMEOUT_MS,
);
