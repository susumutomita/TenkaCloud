import { Match } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import {
  SYNTH_TIMEOUT_MS,
  synthParticipantPortalLambdaOnly,
} from "../../problem-deploy-backend-stack.test-helpers";

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
