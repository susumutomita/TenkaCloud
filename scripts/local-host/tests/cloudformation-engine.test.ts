import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateStackCommand,
  type CreateStackCommandInput,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { AssumeRoleCommand, type AssumeRoleCommandInput } from "@aws-sdk/client-sts";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { CloudFormationEngine, type CredentialsProvider } from "../cloudformation-engine";
import { type ApiResponse, HostingService } from "../service";
import { HostStore } from "../store";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const EXTERNAL_ID = "host-external-id-0123456789";
const OPERATOR_ACCOUNT = "999999999999";
const directories: string[] = [];
const stores: HostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface FakeStack {
  stackId: string;
  name: string;
  status: string;
  reason?: string;
}

/** STS and CloudFormation as they behave for these calls; each poll moves a stack one step. */
class FakeAws {
  readonly assumed: AssumeRoleCommandInput[] = [];
  readonly created: CreateStackCommandInput[] = [];
  readonly deleted: string[] = [];
  readonly stacks: FakeStack[] = [];
  createOutcome: "complete" | "rollback" | "lost-response" = "complete";

  readonly sts = {
    send: async (command: unknown) => {
      if (!(command instanceof AssumeRoleCommand)) throw new Error("unexpected STS call");
      this.assumed.push(command.input);
      return {
        Credentials: {
          AccessKeyId: "AKIA",
          SecretAccessKey: "secret",
          SessionToken: "token",
          Expiration: new Date(Date.now() + 900_000),
        },
      };
    },
  };

  readonly cloudFormation = (credentials: CredentialsProvider) => ({
    send: async (command: unknown) => {
      await credentials();
      if (command instanceof CreateStackCommand) return this.create(command.input);
      if (command instanceof DescribeStacksCommand)
        return this.describe(String(command.input.StackName));
      if (command instanceof DeleteStackCommand) {
        const stack = this.find(String(command.input.StackName));
        if (stack) {
          this.deleted.push(stack.stackId);
          stack.status = "DELETE_IN_PROGRESS";
        }
        return {};
      }
      throw new Error("unexpected CloudFormation call");
    },
  });

  private create(input: CreateStackCommandInput) {
    this.created.push(input);
    const stack: FakeStack = {
      stackId: `arn:aws:cloudformation:ap-northeast-1:111:stack/${input.StackName}/${this.stacks.length}`,
      name: String(input.StackName),
      status: "CREATE_IN_PROGRESS",
    };
    this.stacks.push(stack);
    if (this.createOutcome === "lost-response") throw new Error("socket hang up");
    return { StackId: stack.stackId };
  }

  private find(nameOrId: string): FakeStack | undefined {
    return this.stacks.find(
      (stack) =>
        stack.stackId === nameOrId ||
        (stack.name === nameOrId && stack.status !== "DELETE_COMPLETE"),
    );
  }

  private describe(nameOrId: string) {
    const stack = this.find(nameOrId);
    if (!stack) throw new Error(`Stack with id ${nameOrId} does not exist`);
    if (stack.status === "CREATE_IN_PROGRESS") {
      stack.status = this.createOutcome === "rollback" ? "ROLLBACK_COMPLETE" : "CREATE_COMPLETE";
      if (this.createOutcome === "rollback") stack.reason = "The following resource(s) failed";
    } else if (stack.status === "DELETE_IN_PROGRESS") stack.status = "DELETE_COMPLETE";
    return {
      Stacks: [
        {
          StackId: stack.stackId,
          StackName: stack.name,
          StackStatus: stack.status,
          StackStatusReason: stack.reason,
          Outputs: [
            { OutputKey: "ParameterValue", OutputValue: "TC{secret}" },
            { OutputKey: "ParameterConsoleUrl", OutputValue: "https://console.example/p" },
          ],
        },
      ],
    };
  }
}

async function host() {
  const data = mkdtempSync(join(tmpdir(), "tenka-cloudformation-"));
  directories.push(data);
  const store = new HostStore(new Database(join(data, "host.sqlite")));
  stores.push(store);
  const aws = new FakeAws();
  const engine = new CloudFormationEngine(root, {
    region: "ap-northeast-1",
    externalId: EXTERNAL_ID,
    operatorAccountId: async () => OPERATOR_ACCOUNT,
    sts: aws.sts as never,
    cloudFormation: aws.cloudFormation as never,
    team: (job) => store.team(job.teamId),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    timeoutMs: 60_000,
  });
  const service = new HostingService(store, engine, HOST_KEY);
  const login = await service.admin(
    apiRequest({ method: "POST", path: "/host/login", token: "", body: { key: HOST_KEY } }),
  );
  const token = (login.body as { idToken: string }).idToken;
  const admin = (method: string, path: string, body: Record<string, unknown> = {}) =>
    service.admin(apiRequest({ method, path, token, body }));
  return { store, aws, engine, service, admin };
}

const TEAMS = [
  { internalSlug: "team-a", awsAccountId: "111111111111" },
  { internalSlug: "team-b", awsAccountId: "222222222222", awsRoleName: "Agreed-Role" },
];

async function createEvent(
  admin: (method: string, path: string, body?: Record<string, unknown>) => Promise<ApiResponse>,
) {
  const created = await admin("POST", "/events", {
    name: "cloud rehearsal",
    teams: TEAMS,
    problems: [{ problemId: "hello-world" }],
  });
  expect(created.status).toBe(201);
  return (created.body as { eventId: string }).eventId;
}

test("deploys each team's stack into its own account and tears it down", async () => {
  const { store, aws, engine, service, admin } = await host();
  const eventId = await createEvent(admin);

  expect((await admin("POST", `/events/${eventId}/deploy`)).status).toBe(202);
  await service.drain();

  const jobs = store.jobs(eventId);
  expect(jobs.map((job) => job.status)).toEqual(["COMPLETE", "COMPLETE"]);
  expect(new Set(aws.assumed.map((input) => input.RoleArn))).toEqual(
    new Set([
      "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
      "arn:aws:iam::222222222222:role/Agreed-Role",
    ]),
  );
  expect(aws.assumed.every((input) => input.ExternalId === EXTERNAL_ID)).toBe(true);

  const template = readFileSync(
    join(root, "problems/challenges/hello-world/template.yaml"),
    "utf8",
  );
  const teamA = aws.created.find((input) => input.StackName === "tc-hello-world-team-a");
  const jobA = jobs.find((job) => store.team(job.teamId).internalSlug === "team-a");
  expect(teamA?.TemplateBody).toBe(template);
  expect(teamA?.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
  const parameters = Object.fromEntries(
    (teamA?.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue]),
  );
  expect(parameters.NamePrefix).toBe("tc-hello-world-team-a");
  expect(parameters.TenkaCloudAccountId).toBe(OPERATOR_ACCOUNT);
  expect(parameters.ExternalId).toBe(jobA?.jobId);
  expect(parameters.FlagSeed).toMatch(/^[A-Za-z0-9]{32}$/u);

  if (!jobA) throw new Error("team-a job missing");
  expect(engine.surface(jobA)).toContain("#/stacks/stackinfo?stackId=");
  const view = await engine.view({
    event: store.event(eventId),
    team: store.team(jobA.teamId),
    jobs: [jobA],
    now: Date.now(),
  });
  expect(view).toEqual({
    problems: [
      {
        problemId: "hello-world",
        status: "COMPLETE",
        outputs: { ParameterConsoleUrl: "https://console.example/p" },
      },
    ],
  });

  expect((await admin("DELETE", `/events/${eventId}`)).status).toBe(202);
  await service.drain();
  expect(store.jobs(eventId).map((job) => job.status)).toEqual(["DELETED", "DELETED"]);
  expect(aws.deleted.sort()).toEqual(aws.stacks.map((stack) => stack.stackId).sort());
  expect(aws.stacks.every((stack) => stack.status === "DELETE_COMPLETE")).toBe(true);
});

test("a stack that rolls back fails the job with CloudFormation's reason and is still removed", async () => {
  const { store, aws, service, admin } = await host();
  aws.createOutcome = "rollback";
  const eventId = await createEvent(admin);
  await admin("POST", `/events/${eventId}/deploy`);
  await service.drain();

  const [job] = store.jobs(eventId);
  expect(job?.status).toBe("FAILED");
  expect(job?.error).toContain("ROLLBACK_COMPLETE: The following resource(s) failed");

  await admin("DELETE", `/events/${eventId}`);
  await service.drain();
  expect(store.jobs(eventId).map((each) => each.status)).toEqual(["DELETED", "DELETED"]);
  expect(aws.stacks.every((stack) => stack.status === "DELETE_COMPLETE")).toBe(true);
});

test("a stack whose CreateStack response was lost is found by name and removed", async () => {
  const { store, aws, service, admin } = await host();
  aws.createOutcome = "lost-response";
  const eventId = await createEvent(admin);
  await admin("POST", `/events/${eventId}/deploy`);
  await service.drain();
  expect(store.jobs(eventId).map((job) => job.status)).toEqual(["FAILED", "FAILED"]);
  expect(aws.stacks).toHaveLength(2);

  await admin("DELETE", `/events/${eventId}`);
  await service.drain();
  expect(aws.stacks.every((stack) => stack.status === "DELETE_COMPLETE")).toBe(true);
});

test("an event with a cloud problem requires every team's AWS account", async () => {
  const { admin } = await host();
  const creating = admin("POST", "/events", {
    name: "missing account",
    teams: [{ internalSlug: "team-a" }],
    problems: [{ problemId: "hello-world" }],
  });
  await expect(creating).rejects.toMatchObject({
    status: 422,
    message: "Team team-a needs a 12-digit AWS account ID.",
  });
});

test("recovery marks a job failed when its stack was deleted outside the host", async () => {
  const { store, aws, engine, service, admin } = await host();
  const eventId = await createEvent(admin);
  await admin("POST", `/events/${eventId}/deploy`);
  await service.drain();
  for (const stack of aws.stacks) stack.status = "DELETE_COMPLETE";

  await new HostingService(store, engine, HOST_KEY).recover();
  const recovered = store.jobs(eventId);
  expect(recovered.map((job) => job.status)).toEqual(["FAILED", "FAILED"]);
  expect(recovered[0]?.error).toContain("is gone");
});
