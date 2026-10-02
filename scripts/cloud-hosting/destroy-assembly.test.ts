import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CloudAssembly } from "aws-cdk-lib/cx-api";
import { createDestroyAssembly } from "./destroy-assembly";

const target = {
  name: "tenkacloud-cloud-staging",
  arn: "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tenkacloud-cloud-staging/verified-physical-id",
  account: "123456789012",
  region: "ap-northeast-1",
};
const deployRole =
  "arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-ap-northeast-1";

describe("official CDK destroy assembly", () => {
  it("loads an exact physical ARN with the standard deployment role and no synthesis dependencies", () => {
    const created = createDestroyAssembly(target);
    try {
      const assembly = new CloudAssembly(created.directory);
      const stack = assembly.getStackArtifact(target.name);
      expect(stack.stackName).toBe(target.arn);
      expect(stack.assumeRoleArn).toBe(deployRole);
      expect(stack.cloudFormationExecutionRoleArn).toBeUndefined();
      expect(stack.environment).toMatchObject({ account: target.account, region: target.region });
      expect(stack.dependencies).toEqual([]);
      expect(stack.template).toEqual({ Resources: {} });
      expect(stack.requiresBootstrapStackVersion).toBeUndefined();
      expect(readFileSync(join(created.directory, "manifest.json"), "utf8")).not.toContain(
        "aws:cdk:asset-manifest",
      );
    } finally {
      created.dispose();
    }
    expect(existsSync(created.directory)).toBe(false);
  });

  it.each([false, true])(
    "uses installed CDK credentials and physical deletion (same-account fallback: %s)",
    async (denyAssumption) => {
      const created = createDestroyAssembly(target);
      const requests: { action: string; body: URLSearchParams; authorization: string }[] = [];
      let deleted = false;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = new URLSearchParams(await request.text());
          const action = body.get("Action") ?? "";
          requests.push({
            action,
            body,
            authorization: request.headers.get("authorization") ?? "",
          });
          switch (action) {
            case "GetCallerIdentity":
              return result(
                action,
                `<Account>${target.account}</Account><Arn>arn:aws:iam::${target.account}:user/fixture</Arn><UserId>fixture</UserId>`,
              );
            case "AssumeRole":
              if (denyAssumption)
                return xml(
                  "<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Fixture role assumption denied</Message></Error><RequestId>fixture</RequestId></ErrorResponse>",
                  403,
                );
              return result(
                action,
                `<Credentials><AccessKeyId>ASSUMEDFIXTUREKEY</AccessKeyId><SecretAccessKey>fixture-secret-not-real</SecretAccessKey><SessionToken>fixture-session-not-real</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::${target.account}:assumed-role/fixture/session</Arn><AssumedRoleId>fixture</AssumedRoleId></AssumedRoleUser>`,
              );
            case "DescribeStacks":
              return result(
                action,
                `<Stacks><member><StackName>${target.name}</StackName><StackId>${target.arn}</StackId><CreationTime>2026-01-01T00:00:00Z</CreationTime><StackStatus>${deleted ? "DELETE_COMPLETE" : "CREATE_FAILED"}</StackStatus></member></Stacks>`,
              );
            case "DescribeStackEvents":
              return result(action, "<StackEvents/>");
            case "DeleteStack":
              deleted = true;
              return result(action, "");
            default:
              return xml(
                "<ErrorResponse><Error><Code>UnexpectedFixtureRequest</Code></Error></ErrorResponse>",
                400,
              );
          }
        },
      });
      try {
        const emptyConfig = join(created.directory, "empty-config");
        writeFileSync(emptyConfig, "");
        const endpoint = `http://127.0.0.1:${server.port}`;
        const child = Bun.spawn(
          [
            "node",
            resolve(import.meta.dir, "../../node_modules/aws-cdk/bin/cdk"),
            "--app",
            created.directory,
            "--profile",
            "",
            "--region",
            target.region,
            "--no-notices",
            "--no-version-reporting",
            "destroy",
            target.name,
            "--force",
          ],
          {
            cwd: created.directory,
            env: {
              PATH: process.env.PATH,
              AWS_CONFIG_FILE: emptyConfig,
              AWS_SHARED_CREDENTIALS_FILE: emptyConfig,
              AWS_ACCESS_KEY_ID: "BASEFIXTUREKEY",
              AWS_SECRET_ACCESS_KEY: "fixture-secret-not-real",
              AWS_REGION: target.region,
              AWS_EC2_METADATA_DISABLED: "true",
              AWS_ENDPOINT_URL: endpoint,
              CDK_DISABLE_VERSION_CHECK: "1",
              CDK_DISABLE_CLI_TELEMETRY: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const timeout = setTimeout(() => child.kill(), 20_000);
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(
            code,
            `${stdout}\n${stderr}\n${JSON.stringify(requests.map((r) => r.action))}`,
          ).toBe(0);
        } finally {
          clearTimeout(timeout);
        }
        const assumption = requests.find((request) => request.action === "AssumeRole");
        expect(assumption?.body.get("RoleArn")).toBe(deployRole);
        const deletion = requests.find((request) => request.action === "DeleteStack");
        expect(deletion?.body.get("StackName")).toBe(target.arn);
        expect(deletion?.body.has("RoleARN")).toBe(false);
        expect(deletion?.authorization).toContain(
          denyAssumption ? "BASEFIXTUREKEY" : "ASSUMEDFIXTUREKEY",
        );
        expect(requests.filter((request) => request.action === "DeleteStack")).toHaveLength(1);
        expect(
          requests
            .filter((request) => request.action === "DescribeStacks")
            .every((request) => request.body.get("StackName") === target.arn),
        ).toBe(true);
        expect(
          requests.every((request) =>
            [
              "GetCallerIdentity",
              "AssumeRole",
              "DescribeStacks",
              "DescribeStackEvents",
              "DeleteStack",
            ].includes(request.action),
          ),
        ).toBe(true);
      } finally {
        server.stop(true);
        created.dispose();
      }
    },
    30_000,
  );
});

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/xml" } });
}
function result(action: string, body: string): Response {
  return xml(
    `<${action}Response><${action}Result>${body}</${action}Result><ResponseMetadata><RequestId>fixture</RequestId></ResponseMetadata></${action}Response>`,
  );
}
