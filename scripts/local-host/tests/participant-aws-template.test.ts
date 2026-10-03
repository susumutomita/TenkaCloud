import { expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { parse } from "yaml";
import { z } from "zod";
import { CloudFormationEngine } from "../cloudformation-engine";
import type { Job, Team } from "../model";
import { OPERATOR_ACCOUNT } from "./fake-aws";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const COMPETITOR_ACCOUNT = "111111111111";
const HOST_EXTERNAL_ID = "host-external-id-0123456789";
const REGION = "ap-northeast-1";
const viewerTemplateSchema = z.object({
  Resources: z.object({
    ParticipantViewerRole: z.object({
      Type: z.literal("AWS::IAM::Role"),
      Properties: z.object({
        AssumeRolePolicyDocument: z.object({
          Statement: z.tuple([
            z.object({
              Effect: z.literal("Allow"),
              Action: z.literal("sts:AssumeRole"),
              Principal: z.object({ AWS: z.object({ Sub: z.string() }) }),
              Condition: z.object({
                StringEquals: z.object({ "sts:ExternalId": z.object({ Ref: z.string() }) }),
              }),
            }),
          ]),
        }),
      }),
    }),
  }),
  Outputs: z.object({
    ParticipantViewerRoleArn: z.object({
      Value: z.object({ GetAtt: z.literal("ParticipantViewerRole.Arn") }),
    }),
  }),
});

function credentials(accessKeyId: string) {
  return {
    AccessKeyId: accessKeyId,
    SecretAccessKey: "synthetic-secret",
    SessionToken: "synthetic-token",
    Expiration: new Date(Date.now() + 3_600_000),
  };
}

for (const problemId of ["hello-world", "hello-world-battle"]) {
  test(`${problemId}: operator-issued participant access matches the deployed template trust`, async () => {
    const team: Team = {
      teamId: "01K6AAAAAAAAAAAAAAAAAAAAAA",
      eventId: "01K6BBBBBBBBBBBBBBBBBBBBBB",
      internalSlug: "alpha",
      displayName: "Alpha",
      loginKey: "synthetic-key",
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
      aws: { accountId: COMPETITOR_ACCOUNT, roleName: "TenkaCloud-CompetitorDeploy-Role" },
    };
    const job: Job = {
      jobId: "01K6CCCCCCCCCCCCCCCCCCCCCC",
      eventId: team.eventId,
      teamId: team.teamId,
      problemId,
      definition: "",
      offset: 0,
      status: "COMPLETE",
      unit: null,
    };
    const viewerRoleArn = `arn:aws:iam::${COMPETITOR_ACCOUNT}:role/${problemId}-viewer`;
    let trustedPrincipal = "";
    let trustedExternalId = "";
    let stack: Stack | undefined;
    const calls: { roleArn: string; callerAccount: string; externalId: string }[] = [];
    const sts = new STSClient({
      region: REGION,
      credentials: { accessKeyId: OPERATOR_ACCOUNT, secretAccessKey: "synthetic-secret" },
    });
    const stsDestroy = spyOn(sts, "destroy");
    // Intercept every STS client, including an accidentally reintroduced deploy-credential
    // client. This makes an invalid chain fail deterministically without any AWS request.
    const stsSend = spyOn(STSClient.prototype, "send").mockImplementation(async function (
      this: STSClient,
      command,
    ) {
      if (!(command instanceof AssumeRoleCommand)) throw new Error("Unexpected STS command");
      const callerAccount = (await this.config.credentials()).accessKeyId;
      const roleArn = command.input.RoleArn ?? "";
      const externalId = command.input.ExternalId ?? "";
      calls.push({ roleArn, callerAccount, externalId });
      if (roleArn === viewerRoleArn) {
        if (
          `arn:aws:iam::${callerAccount}:root` !== trustedPrincipal ||
          externalId !== trustedExternalId
        )
          throw new Error("AccessDenied: deployed viewer trust rejects the caller");
        return { $metadata: {}, Credentials: credentials("viewer-access") };
      }
      expect(callerAccount).toBe(OPERATOR_ACCOUNT);
      expect(roleArn).toBe(
        `arn:aws:iam::${COMPETITOR_ACCOUNT}:role/TenkaCloud-CompetitorDeploy-Role`,
      );
      expect(externalId).toBe(HOST_EXTERNAL_ID);
      return { $metadata: {}, Credentials: credentials(COMPETITOR_ACCOUNT) };
    });
    const cloud = new CloudFormationClient({ region: REGION });
    const cloudSend = spyOn(cloud, "send").mockImplementation(async (command) => {
      if (command instanceof CreateStackCommand) {
        const input = command.input;
        const template = viewerTemplateSchema.parse(
          parse(input.TemplateBody ?? "", {
            logLevel: "silent",
            customTags: ["Ref", "Sub", "GetAtt"].map((name) => ({
              tag: `!${name}`,
              resolve: (value: string) => ({ [name]: value }),
            })),
          }),
        );
        const trust =
          template.Resources.ParticipantViewerRole.Properties.AssumeRolePolicyDocument.Statement[0];
        const parameters = Object.fromEntries(
          (input.Parameters ?? []).map((parameter) => [
            parameter.ParameterKey,
            parameter.ParameterValue,
          ]),
        );
        trustedPrincipal = trust.Principal.AWS.Sub.replace(
          /\$\{TenkaCloudAccountId\}/gu,
          z.string().parse(parameters.TenkaCloudAccountId),
        );
        trustedExternalId = z
          .string()
          .parse(parameters[trust.Condition.StringEquals["sts:ExternalId"].Ref]);
        expect(trustedPrincipal).toBe(`arn:aws:iam::${OPERATOR_ACCOUNT}:root`);
        expect(trustedExternalId).toBe(job.jobId);
        stack = {
          StackId: `arn:aws:cloudformation:${REGION}:${COMPETITOR_ACCOUNT}:stack/${input.StackName}/synthetic`,
          StackName: input.StackName,
          CreationTime: new Date(),
          Tags: input.Tags,
          StackStatus: "CREATE_COMPLETE",
          Outputs: [
            { OutputKey: "ParticipantViewerRoleArn", OutputValue: viewerRoleArn },
            { OutputKey: "ParameterValue", OutputValue: "synthetic-flag" },
            { OutputKey: "Ec2HostHint", OutputValue: "ec2.example.com" },
            { OutputKey: "InstanceId", OutputValue: "i-0123456789abcdef0" },
          ],
        };
        return { $metadata: {}, StackId: stack.StackId };
      }
      if (command instanceof DescribeStacksCommand && stack)
        return { $metadata: {}, Stacks: [stack] };
      throw new Error("Unexpected CloudFormation command");
    });
    const engine = new CloudFormationEngine(root, {
      region: REGION,
      externalId: HOST_EXTERNAL_ID,
      operatorAccountId: async () => OPERATOR_ACCOUNT,
      team: () => team,
      sts,
      cloudFormation: () => cloud,
      federationFetch: async (_url, init) => {
        const session = JSON.parse(new URLSearchParams(String(init.body)).get("Session") ?? "null");
        expect(session).toEqual({
          sessionId: "viewer-access",
          sessionKey: "synthetic-secret",
          sessionToken: "synthetic-token",
        });
        return Response.json({ SigninToken: "synthetic-signin-token" });
      },
      sleep: async () => undefined,
      pollIntervalMs: 0,
      timeoutMs: 1000,
    });
    try {
      const problem = engine.catalog().find((entry) => entry.problemId === problemId);
      if (!problem) throw new Error("Missing reviewed AWS problem");
      job.definition = problem.definition;
      await engine.start(job, (unit) => {
        job.unit = unit;
      });
      for (const kind of ["cli", "console"] as const) {
        calls.length = 0;
        const access = await engine.participantAwsAccess({
          kind,
          job,
          assertCurrent: () => undefined,
        });
        expect(access.kind).toBe(kind);
        expect(calls).toEqual([
          {
            roleArn: `arn:aws:iam::${COMPETITOR_ACCOUNT}:role/TenkaCloud-CompetitorDeploy-Role`,
            callerAccount: OPERATOR_ACCOUNT,
            externalId: HOST_EXTERNAL_ID,
          },
          { roleArn: viewerRoleArn, callerAccount: OPERATOR_ACCOUNT, externalId: job.jobId },
        ]);
        if (access.kind === "cli") expect(access.credentials.accessKeyId).toBe("viewer-access");
      }
      expect(stsDestroy).not.toHaveBeenCalled();
    } finally {
      cloudSend.mockRestore();
      stsSend.mockRestore();
      stsDestroy.mockRestore();
      cloud.destroy();
      sts.destroy();
    }
  });
}
