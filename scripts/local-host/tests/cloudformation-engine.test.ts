import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { CloudFormationEngine } from "../cloudformation-engine";
import { type ApiResponse, HostingService } from "../service";
import { HostStore } from "../store";
import { FakeAws, OPERATOR_ACCOUNT } from "./fake-aws";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const EXTERNAL_ID = "host-external-id-0123456789";
const directories: string[] = [];
const stores: HostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

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
  service.accountConnection = {
    region: "ap-northeast-1",
    operatorAccountId: OPERATOR_ACCOUNT,
    externalId: EXTERNAL_ID,
    verify: async (accountId, roleName) => {
      await aws.sts.send(
        new (await import("@aws-sdk/client-sts")).AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
          ExternalId: EXTERNAL_ID,
          RoleSessionName: "test-verify",
        }),
      );
    },
  };
  const login = await service.admin(
    apiRequest({ method: "POST", path: "/host/login", token: "", body: { key: HOST_KEY } }),
  );
  const token = (login.body as { idToken: string }).idToken;
  const admin = (method: string, path: string, body: Record<string, unknown> = {}) =>
    service.admin(apiRequest({ method, path, token, body }));
  for (const [awsAccountId, competitorRoleName] of [
    ["111111111111", "TenkaCloud-local-host-deploy-Role"],
    ["222222222222", "Agreed-Role"],
  ]) {
    await admin("POST", "/admin/competitor-accounts", { awsAccountId, competitorRoleName });
    await admin("POST", `/admin/competitor-accounts/${awsAccountId}/verify`);
  }
  return { store, aws, engine, service, admin };
}

const TEAM_A = { internalSlug: "team-a", awsAccountId: "111111111111" };
const TEAMS = [TEAM_A, { internalSlug: "team-b", awsAccountId: "222222222222" }];

async function createEvent(
  admin: (method: string, path: string, body?: Record<string, unknown>) => Promise<ApiResponse>,
  teams = TEAMS,
) {
  const created = await admin("POST", "/events", {
    name: "cloud rehearsal",
    teams,
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
      "arn:aws:iam::111111111111:role/TenkaCloud-local-host-deploy-Role",
      "arn:aws:iam::222222222222:role/Agreed-Role",
    ]),
  );
  expect(aws.assumed.every((input) => input.ExternalId === EXTERNAL_ID)).toBe(true);

  const template = readFileSync(
    join(root, "problems/challenges/hello-world/template.yaml"),
    "utf8",
  );
  const teamA = aws.created.find((input) =>
    String(input.StackName).startsWith("tc-hello-world-team-a-"),
  );
  const jobA = jobs.find((job) => store.team(job.teamId).internalSlug === "team-a");
  expect(teamA?.StackName).toBe(`tc-hello-world-team-a-${jobA?.jobId.slice(-12).toLowerCase()}`);
  expect(teamA?.TemplateBody).toBe(template);
  expect(teamA?.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
  const parameters = Object.fromEntries(
    (teamA?.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue]),
  );
  expect(parameters.NamePrefix).toBe(teamA?.StackName);
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
  expect(view.problems).toMatchObject([
    { problemId: "hello-world", awsAccountId: "111111111111", region: "ap-northeast-1" },
  ]);
  expect((view.problems as { stackOutputs: unknown }[])[0]?.stackOutputs).toEqual({
    ParameterConsoleUrl: "https://console.example/p",
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

test.each(["missing", "blank"] as const)(
  "a %s flag output fails deployment and retry replaces the owned stack",
  async (flagOutput) => {
    const { store, aws, service, admin } = await host();
    aws.flagOutput = flagOutput;
    const eventId = await createEvent(admin, [TEAM_A]);
    await admin("POST", `/events/${eventId}/deploy`);
    await service.drain();
    expect(store.event(eventId).status).toBe("DEPLOYING");
    expect(store.jobs(eventId)[0]?.status).toBe("FAILED");
    expect(store.jobs(eventId)[0]?.error).toContain("has no ParameterValue flag output");

    aws.flagOutput = "flag";
    await admin("POST", `/events/${eventId}/deploy`, { retryFailedOnly: true });
    await service.drain();
    expect(store.event(eventId).status).toBe("READY");
    expect(store.jobs(eventId)[0]?.status).toBe("COMPLETE");
    expect(aws.stacks.map((stack) => stack.status)).toEqual(["DELETE_COMPLETE", "CREATE_COMPLETE"]);
  },
);

test("two events can use the same team account and slug without sharing a stack", async () => {
  const { store, aws, service, admin } = await host();
  const first = await createEvent(admin);
  const second = await createEvent(admin);
  for (const eventId of [first, second]) {
    await admin("POST", `/events/${eventId}/deploy`);
    await service.drain();
    expect(store.jobs(eventId).map((job) => job.status)).toEqual(["COMPLETE", "COMPLETE"]);
  }
  expect(new Set(aws.created.map((input) => input.StackName)).size).toBe(4);
  const firstIds = new Set(
    store.jobs(first).map((job) => (JSON.parse(job.unit ?? "{}") as { stackId: string }).stackId),
  );
  await admin("DELETE", `/events/${first}`);
  await service.drain();
  expect(new Set(aws.deleted)).toEqual(firstIds);
  expect(
    aws.stacks.filter((stack) => !firstIds.has(stack.stackId)).map((stack) => stack.status),
  ).toEqual(["CREATE_COMPLETE", "CREATE_COMPLETE"]);
});

test("an unowned stack with the reserved name is neither scored nor deleted", async () => {
  for (const tags of [[], [{ Key: "tenkacloud:job", Value: "another-job" }]]) {
    const { store, aws, engine, service, admin } = await host();
    aws.beforeCreate = (input) => {
      aws.seedStack(String(input.StackName), tags);
    };
    const eventId = await createEvent(admin, [TEAM_A]);
    await admin("POST", `/events/${eventId}/deploy`);
    await service.drain();
    const [job] = store.jobs(eventId);
    if (!job) throw new Error("Expected a deployment job.");
    expect(job.status).toBe("FAILED");
    await expect(
      engine.submit(
        {
          event: store.event(eventId),
          team: store.team(job.teamId),
          jobs: [job],
          now: Date.now(),
        },
        { problemId: "hello-world", flag: "TC{guess}" },
      ),
    ).rejects.toMatchObject({ status: 409, kind: "not_deployed" });
    await admin("DELETE", `/events/${eventId}`);
    await service.drain();
    expect(aws.deleted).toEqual([]);
    expect(aws.stacks.map((stack) => stack.status)).toEqual(["CREATE_COMPLETE"]);
    expect(store.jobs(eventId)[0]?.status).toBe("DELETED");
  }
});

test("recovery refuses a recorded stack whose ownership tag changed", async () => {
  const { store, aws, engine, service, admin } = await host();
  const eventId = await createEvent(admin, [TEAM_A]);
  await admin("POST", `/events/${eventId}/deploy`);
  await service.drain();
  const [stack] = aws.stacks;
  if (!stack) throw new Error("Expected a stack.");
  stack.tags = [{ Key: "tenkacloud:job", Value: "another-job" }];

  await new HostingService(store, engine, HOST_KEY).recover();
  expect(store.jobs(eventId)[0]?.status).toBe("FAILED");
  expect(store.jobs(eventId)[0]?.error).toContain("does not belong");
  await admin("DELETE", `/events/${eventId}`);
  await service.drain();
  expect(aws.deleted).toEqual([]);
  expect(stack.status).toBe("CREATE_COMPLETE");
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
    message: "Team team-a needs a registered AWS account.",
  });
});

test("registered roles are verified and pinned to event teams; assigned accounts cannot be deleted", async () => {
  const { admin, store } = await host();
  const listed = await admin("GET", "/admin/competitor-accounts");
  expect(
    (listed.body as { items: { verified: boolean }[] }).items.map((item) => item.verified),
  ).toEqual([true, true]);
  await expect(
    admin("POST", "/events", {
      name: "role override",
      teams: [{ ...TEAMS[0], awsRoleName: "Administrator" }],
      problems: [{ problemId: "hello-world" }],
    }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    admin("POST", "/admin/competitor-accounts", {
      awsAccountId: "333333333333",
      region: "us-east-1",
    }),
  ).rejects.toMatchObject({ status: 422 });
  await admin("POST", "/admin/competitor-accounts", {
    awsAccountId: "333333333333",
    competitorRoleName: "Custom-Role",
  });
  await expect(
    admin("POST", "/events", {
      name: "unverified",
      teams: [{ internalSlug: "third", awsAccountId: "333333333333" }],
      problems: [{ problemId: "hello-world" }],
    }),
  ).rejects.toMatchObject({ status: 422 });
  await admin("POST", "/admin/competitor-accounts/333333333333/verify");
  expect((await admin("DELETE", "/admin/competitor-accounts/333333333333")).status).toBe(200);
  const eventId = await createEvent(admin);
  expect(store.teams(eventId).map((team) => team.aws?.roleName)).toEqual([
    "TenkaCloud-local-host-deploy-Role",
    "Agreed-Role",
  ]);
  await expect(admin("DELETE", "/admin/competitor-accounts/111111111111")).rejects.toMatchObject({
    status: 409,
  });
});

test("Operator can distribute team keys but only Admin manages competitor connections", async () => {
  const { admin, store, service } = await host();
  const eventId = await createEvent(admin);
  const now = Date.now();
  store.addSession("operator-token", "operator-refresh", now + 60_000, now, "Operator");
  store.addSession("viewer-token", "viewer-refresh", now + 60_000, now, "Viewer");
  const call = (
    token: string,
    method: string,
    path: string,
    body: Record<string, unknown> = {},
    query = new URLSearchParams(),
  ) => service.admin(apiRequest({ method, path, token, body, query }));
  const keysQuery = new URLSearchParams({ withTeamLoginKeys: "true" });
  const operator = await call("operator-token", "GET", `/events/${eventId}`, {}, keysQuery);
  expect(operator.status).toBe(200);
  await expect(
    call("operator-token", "POST", "/admin/competitor-accounts", { awsAccountId: "333333333333" }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    call("viewer-token", "GET", `/events/${eventId}`, {}, keysQuery),
  ).rejects.toMatchObject({ status: 403 });
  await expect(call("viewer-token", "POST", `/events/${eventId}/deploy`)).rejects.toMatchObject({
    status: 403,
  });
});

test("failed re-verification revokes eligibility without exposing SDK error text", async () => {
  const { admin, store, service } = await host();
  const connection = service.accountConnection;
  if (!connection) throw new Error("account connection missing");
  service.accountConnection = {
    ...connection,
    verify: async () => {
      throw new Error("AWS secret credential should never appear in API output");
    },
  };
  await expect(
    admin("POST", "/admin/competitor-accounts/111111111111/verify"),
  ).rejects.toMatchObject({
    status: 422,
    message:
      "Could not verify the competitor role. Check the account, role, ExternalId, and operator trust.",
  });
  expect(store.account("111111111111")).toMatchObject({ verified: false });
  expect(store.account("111111111111").verifiedAt).toBeUndefined();
  await expect(
    admin("POST", "/events", {
      name: "rejected after failed check",
      teams: [{ internalSlug: "team-a", awsAccountId: "111111111111" }],
      problems: [{ problemId: "hello-world" }],
    }),
  ).rejects.toMatchObject({ status: 422 });
});

test("a revoked Admin session cannot save a pending verification result", async () => {
  const { store, service } = await host();
  const connection = service.accountConnection;
  if (!connection) throw new Error("account connection missing");
  let finish: (() => void) | undefined;
  service.accountConnection = {
    ...connection,
    verify: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  };
  const now = Date.now();
  store.addSession("pending-admin", "pending-refresh", now + 60_000, now, "Admin");
  const pending = service.admin(
    apiRequest({
      method: "POST",
      path: "/admin/competitor-accounts/111111111111/verify",
      token: "pending-admin",
    }),
  );
  await Promise.resolve();
  store.revokeSession("pending-refresh");
  if (!finish) throw new Error("verification did not start");
  finish();
  await expect(pending).rejects.toMatchObject({ status: 401 });
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
