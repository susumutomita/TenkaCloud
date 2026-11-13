import { Database } from "bun:sqlite";
import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { id } from "../auth";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { CloudFormationEngine, cloudFormationCatalog } from "../cloudformation-engine";
import { CompetitionEngine } from "../competition-engine";
import { declaredDisruptions, pinDisruption } from "../disruption-catalog";
import { type DisruptionExecution, disruptionExecutionSchema } from "../disruption-model";
import type { Context, Job } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { DisruptionAws } from "./disruption-fixture";
import { FakeAws, OPERATOR_ACCOUNT } from "./fake-aws";
import { bootstrapOrganizer } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const unsupported = {
  status: 409,
  kind: "simulator_problem_unsupported",
  message:
    "This AWS problem is unavailable in simulator mode. Only problems reviewed for the Simulator can be deployed there.",
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

const LAMBDA_SIMULATOR = ["sts", "iam", "cloudformation", "ssm", "lambda"] as const;

function host(
  simulator = true,
  consoleReady = false,
  simulatorServices: readonly string[] = LAMBDA_SIMULATOR,
) {
  const directory = mkdtempSync(join(tmpdir(), "tenka-simulator-catalog-"));
  const store = new HostStore(new Database(":memory:"));
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const aws = new FakeAws();
  const disruptionAws = new DisruptionAws();
  const ssm = mock(disruptionAws.ssm);
  const cloudFormation = mock(aws.cloudFormation);
  const operatorAccountId = mock(async () => OPERATOR_ACCOUNT);
  const cloud = new CloudFormationEngine(root, {
    ...(simulator ? { simulatorEndpoint: "http://127.0.0.1:4566", simulatorServices } : {}),
    ...(consoleReady
      ? { simulatorConsole: async () => "http://127.0.0.1:4566/_simulator/login" }
      : {}),
    region: "ap-northeast-1",
    externalId: "fixture-external-id-0123456789",
    operatorAccountId,
    sts: aws.sts as never,
    cloudFormation: cloudFormation as never,
    ssm: ssm as never,
    team: (job) => store.team(job.teamId),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });
  const engine = new CompetitionEngine(root, directory, false, cloud);
  const service = new HostingService(store, engine, HOST_KEY);
  return {
    aws,
    disruptionAws,
    ssm,
    cloud,
    cloudFormation,
    operatorAccountId,
    engine,
    store,
    service,
  };
}

type Host = ReturnType<typeof host>;

function savedJob(
  fixture: Host,
  problemId = "hello-world-battle",
  parameterName?: string,
): Context & { job: Job } {
  const problem = cloudFormationCatalog(root).find((entry) => entry.problemId === problemId);
  if (!problem) throw new Error(`Missing reviewed problem ${problemId}`);
  const now = Date.now();
  const eventId = id();
  const teamId = id();
  const context: Context = {
    now,
    event: {
      eventId,
      name: "Retained AWS event",
      status: "READY",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      startsAt: new Date(now - 1000).toISOString(),
      expiresAt: Math.floor(now / 1000) + 3600,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: [problem],
    },
    team: {
      teamId,
      eventId,
      internalSlug: "alpha",
      displayName: "Alpha",
      loginKey: "saved-team-key",
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
      aws: { accountId: "000000000000", roleName: "TenkaCloud-SimulatorDeploy-Role" },
    },
    jobs: [],
  };
  const job: Job = {
    jobId: id(),
    eventId,
    teamId,
    problemId,
    definition: problem.definition,
    offset: 0,
    status: "COMPLETE",
    deployedAt: now - 1000,
    unit: JSON.stringify({
      kind: "cloudformation",
      accountId: "000000000000",
      roleArn: "arn:aws:iam::000000000000:role/TenkaCloud-SimulatorDeploy-Role",
      region: "ap-northeast-1",
      stackName: "retained-stack",
      stackId: "arn:aws:cloudformation:ap-northeast-1:000000000000:stack/retained-stack/1",
      outputs: {
        ...(parameterName ? { ParameterName: parameterName } : {}),
        ParticipantViewerRoleArn: "arn:aws:iam::000000000000:role/retained-viewer",
        ParameterValue: "retained-flag",
        Ec2HostHint: "retained-host",
        InstanceId: "i-0123456789abcdef0",
      },
    }),
  };
  context.jobs.push(job);
  fixture.store.putEvent(context.event);
  fixture.store.putTeam(context.team);
  fixture.store.putJob(job);
  return { ...context, job };
}

function expectNoAws(fixture: Host) {
  expect(fixture.cloudFormation).not.toHaveBeenCalled();
  expect(fixture.operatorAccountId).not.toHaveBeenCalled();
  expect(fixture.ssm).not.toHaveBeenCalled();
  expect(fixture.aws.assumed).toEqual([]);
  expect(fixture.aws.created).toEqual([]);
  expect(fixture.aws.deleted).toEqual([]);
}

test("simulator catalog exposes only the reviewed Simulator problems and leaves the AWS catalog unchanged", async () => {
  const fixture = host();
  const ordinary = cloudFormationCatalog(root);
  expect(ordinary.map((problem) => problem.problemId)).toEqual([
    "hello-world",
    "hello-world-battle",
    "lambda-settings-viewer",
  ]);
  expect(host(false).cloud.catalog()).toEqual(ordinary);
  expect(fixture.cloud.catalog()).toEqual(
    ordinary.filter((problem) => problem.problemId !== "hello-world-battle"),
  );
  const token = await bootstrapOrganizer(fixture.service, HOST_KEY);
  const catalog = await fixture.service.admin(
    apiRequest({ method: "GET", path: "/host/catalog", token }),
  );
  const items = (catalog.body as { items: { problemId: string; runtime: string }[] }).items;
  expect(
    items.filter((entry) => entry.runtime === "cloudformation").map((entry) => entry.problemId),
  ).toEqual(["hello-world", "lambda-settings-viewer"]);
  await expect(
    fixture.service.admin(
      apiRequest({
        method: "POST",
        path: "/events",
        token,
        body: {
          name: "Unsupported simulator event",
          teams: [{ internalSlug: "alpha" }],
          problems: [{ problemId: "hello-world-battle" }],
        },
      }),
    ),
  ).rejects.toMatchObject({
    status: 422,
    message: "Problem is not supported by local hosting: hello-world-battle",
  });
  expectNoAws(fixture);
});

test.each(["start", "recover", "resume", "stop", "cli", "console", "logs"] as const)(
  "saved unsupported simulator jobs reject %s before requests or ownership changes",
  async (operation) => {
    const fixture = host();
    const context = savedJob(fixture);
    const original = structuredClone(context.job);
    const retain = mock();
    await expect(
      Promise.resolve().then((): Promise<unknown> => {
        if (operation === "start") return fixture.engine.start(context.job, retain);
        if (operation === "cli" || operation === "console")
          return fixture.engine.participantAwsAccess({
            kind: operation,
            job: context.job,
            assertCurrent: () => undefined,
          });
        if (operation === "logs") return fixture.engine.deploymentLogs(context, context.job.jobId);
        return fixture.engine[operation](context.job);
      }),
    ).rejects.toMatchObject(unsupported);
    expect(retain).not.toHaveBeenCalled();
    expect(context.job).toEqual(original);
    expectNoAws(fixture);
  },
);

test.each(["job", "definition"] as const)(
  "a mismatched %s identity cannot bypass simulator support",
  async (identity) => {
    const fixture = host();
    const { job } = savedJob(fixture);
    if (identity === "job") job.problemId = "hello-world";
    else
      job.definition = JSON.stringify({ ...JSON.parse(job.definition), problemId: "hello-world" });
    await expect(fixture.engine.start(job, mock())).rejects.toMatchObject(unsupported);
    expectNoAws(fixture);
  },
);

test.each([
  { consoleReady: false, parameterName: "/own/flag", capabilities: ["cli-credentials"] },
  { consoleReady: true, parameterName: undefined, capabilities: ["cli-credentials"] },
  { consoleReady: true, parameterName: "/own/flag", capabilities: ["console", "cli-credentials"] },
])(
  "Simulator Console capability requires both native support and own retained target ($consoleReady, $parameterName)",
  async ({ consoleReady, parameterName, capabilities }) => {
    const fixture = host(true, consoleReady);
    const context = savedJob(fixture, "hello-world", parameterName);
    const view = await fixture.engine.view(context);
    expect(view.problems).toMatchObject([
      { problemId: "hello-world", consoleKind: "simulator", accessCapabilities: capabilities },
    ]);
    expect(fixture.aws.created).toEqual([]);
    expect(fixture.aws.deleted).toEqual([]);
  },
);

test.each([false, true])(
  "the Lambda problem offers CLI credentials only, with or without Simulator Console support (%p)",
  async (consoleReady) => {
    const fixture = host(true, consoleReady);
    const context = savedJob(fixture, "lambda-settings-viewer");
    const unit = JSON.parse(context.job.unit ?? "{}");
    unit.outputs = {
      ...unit.outputs,
      FunctionName: "tc-lambda-settings-viewer-alpha-0123456789ab",
      FunctionConsoleUrl: "https://console.aws.amazon.com/lambda/home#/functions/retained",
      ReleaseTokenValue: "TC{retained-flag}",
    };
    context.job.unit = JSON.stringify(unit);
    fixture.store.putJob(context.job);
    const view = await fixture.engine.view(context);
    expect(view.problems).toMatchObject([
      {
        problemId: "lambda-settings-viewer",
        consoleKind: "simulator",
        accessCapabilities: ["cli-credentials"],
      },
    ]);
    // Simulator mode hides console deep links, and the flag output is never shown.
    expect(view.problems).toEqual([
      expect.objectContaining({
        stackOutputs: {
          FunctionName: "tc-lambda-settings-viewer-alpha-0123456789ab",
          ParticipantViewerRoleArn: "arn:aws:iam::000000000000:role/retained-viewer",
          ParameterValue: "retained-flag",
          Ec2HostHint: "retained-host",
          InstanceId: "i-0123456789abcdef0",
        },
      }),
    ]);
    expect(fixture.aws.created).toEqual([]);
  },
);

test("a Simulator that does not advertise Lambda sessions hides the Lambda problem and refuses its saved jobs", async () => {
  const fixture = host(true, false, ["sts", "iam", "cloudformation", "ssm"]);
  expect(fixture.cloud.catalog().map((problem) => problem.problemId)).toEqual(["hello-world"]);
  const context = savedJob(fixture, "lambda-settings-viewer");
  const view = await fixture.engine.view(context);
  expect(view.problems).toMatchObject([
    { problemId: "lambda-settings-viewer", accessCapabilities: [] },
  ]);
  await expect(fixture.engine.start(context.job, mock())).rejects.toMatchObject(unsupported);
  await expect(
    Promise.resolve().then(() =>
      fixture.engine.participantAwsAccess({
        kind: "cli",
        job: context.job,
        assertCurrent: () => undefined,
      }),
    ),
  ).rejects.toMatchObject(unsupported);
  expectNoAws(fixture);
});

test("saved unsupported jobs keep their state and expose no CLI capability in simulator mode", async () => {
  const fixture = host();
  const context = savedJob(fixture);
  const view = await fixture.engine.view(context);
  expect(view.problems).toMatchObject([
    {
      problemId: "hello-world-battle",
      accessCapabilities: [],
      deployLog: { error: "unavailable" },
    },
  ]);
  await expect(
    fixture.service.participant(
      apiRequest({
        method: "GET",
        path: "/portal/me/cli-credentials",
        query: new URLSearchParams({ jobId: context.job.jobId }),
        token: context.team.loginKey,
      }),
    ),
  ).rejects.toMatchObject(unsupported);
  await fixture.service.recover();
  expect(fixture.store.job(context.job.jobId)).toMatchObject({
    status: "FAILED",
    error: unsupported.message,
    definition: context.job.definition,
    unit: context.job.unit,
  });
  const token = await bootstrapOrganizer(fixture.service, HOST_KEY);
  const result = await fixture.service.admin(
    apiRequest({
      method: "POST",
      path: `/events/${context.event.eventId}/deployments/${context.job.jobId}/restart`,
      token,
    }),
  );
  expect(result.status).toBe(202);
  await fixture.service.drain();
  expect(fixture.store.job(context.job.jobId)).toMatchObject({
    status: "FAILED",
    error: unsupported.message,
    definition: context.job.definition,
    unit: context.job.unit,
  });
  expectNoAws(fixture);
});

test.each([
  { simulator: true, problemId: "hello-world" },
  { simulator: true, problemId: "lambda-settings-viewer" },
  { simulator: false, problemId: "hello-world-battle" },
])(
  "$problemId lifecycle remains available with simulator=$simulator",
  async ({ simulator, problemId }) => {
    const fixture = host(simulator);
    const { job } = savedJob(fixture, problemId);
    job.unit = null;
    await fixture.engine.start(job, (unit) => {
      job.unit = unit;
    });
    expect(fixture.aws.created[0]?.TemplateBody).toBe(JSON.parse(job.definition).templateBody);
    await fixture.engine.recover(job);
    await fixture.engine.resume(job);
    await fixture.engine.stop(job);
    expect(fixture.aws.created).toHaveLength(1);
    expect(fixture.aws.deleted).toHaveLength(1);
  },
);

const retainedStatuses = [
  "injecting",
  "inject_pending",
  "inject_unknown",
  "revert_due",
  "reverting",
  "revert_pending",
  "recovery_required",
] as const;
type RetainedStatus = (typeof retainedStatuses)[number];

function retainDisruption(
  fixture: Host,
  context: ReturnType<typeof savedJob>,
  status: RetainedStatus,
): DisruptionExecution {
  const problem = context.event.problems[0];
  const declaration = problem && declaredDisruptions(problem).disruptions[0];
  if (!problem || !declaration) throw new Error("Missing original Battle disruption");
  const target = pinDisruption({
    problem,
    declaration,
    parameters: declaration.parameters ?? {},
    job: context.job,
    team: context.team,
  });
  const requestId = "retained-disruption";
  fixture.service.disruptions.store.putRequest({
    eventId: context.event.eventId,
    requestId,
    fingerprint: "retained-fingerprint",
    input: {
      problemId: problem.problemId,
      disruptionId: declaration.id,
      requestId,
      scope: "all",
      timing: "immediate",
    },
    auditId: "retained-audit",
    firedBy: "host-key",
    firedAt: new Date(context.now - 1000).toISOString(),
    targetTeamIds: [context.team.teamId],
    parameters: {},
    dueAt: context.now - 1000,
    endsAt: context.now - 1000,
    cancelled: false,
  });
  const inject = {
    key: "retained-inject-key",
    sentAt: context.now - 1000,
    ...(["injecting", "inject_unknown"].includes(status)
      ? {}
      : { operationId: "retained-inject-command" }),
  };
  const revert = {
    key: "retained-revert-key",
    sentAt: context.now - 500,
    ...(status === "reverting" ? {} : { operationId: "retained-revert-command" }),
  };
  const row = disruptionExecutionSchema.parse({
    id: "retained-execution",
    eventId: context.event.eventId,
    requestId,
    tick: 1,
    teamId: context.team.teamId,
    dueAt: context.now - 1000,
    updatedAt: context.now,
    target,
    status,
    inject,
    revertAt: context.now - 1,
    ...(status === "revert_due" ? { injectOutcome: "completed" } : {}),
    ...(["reverting", "revert_pending", "recovery_required"].includes(status) ? { revert } : {}),
    ...(["inject_unknown", "recovery_required"].includes(status) ? { reason: "retained" } : {}),
  });
  fixture.service.disruptions.store.putExecution(row);
  fixture.disruptionAws.now = context.now;
  for (const [operation, dispatch, commandId] of [
    [inject, target.inject, "retained-inject-command"],
    ...(status === "reverting" || status === "revert_pending" || status === "recovery_required"
      ? ([[revert, target.revert, "retained-revert-command"]] as const)
      : []),
  ] as const) {
    fixture.disruptionAws.commands.push({
      CommandId: commandId,
      Comment: operation.key,
      DocumentName: dispatch.documentName ?? "AWS-RunShellScript",
      InstanceIds: target.inject.target.split(","),
      Parameters: Object.fromEntries(
        Object.entries(dispatch.params).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.map(String) : [String(value)],
        ]),
      ),
      RequestedDateTime: new Date(operation.sentAt),
      Status: "Success",
    });
  }
  return row;
}

test.each(
  retainedStatuses.flatMap((status) => [
    { status, simulator: true },
    { status, simulator: false },
  ]),
)(
  "retained $status recovery stays unresolved only in simulator mode ($simulator)",
  async ({ status, simulator }) => {
    const fixture = host(simulator);
    const context = savedJob(fixture);
    if (!simulator) {
      context.job.unit = null;
      await fixture.engine.start(context.job, (unit) => {
        context.job.unit = unit;
      });
      fixture.store.putJob(context.job);
    }
    const before = retainDisruption(fixture, context, status);
    const retainedCommands = fixture.disruptionAws.commands.length;
    await fixture.service.recover();
    expect(fixture.store.job(context.job.jobId)).toMatchObject({
      status: simulator ? "FAILED" : "COMPLETE",
      unit: context.job.unit,
      deployedAt: context.job.deployedAt,
    });
    await fixture.service.disruptions.tick();
    await fixture.service.disruptions.tick();
    const after = fixture.service.disruptions.store.executions(context.event.eventId)[0];
    expect(after?.target).toEqual(before.target);
    if (simulator) {
      expectNoAws(fixture);
      expect(fixture.disruptionAws.commands).toHaveLength(retainedCommands);
      expect(after?.status).toBe(
        status.startsWith("inject") ? "inject_unknown" : "recovery_required",
      );
      expect(after).toMatchObject({
        inject: "inject" in before ? before.inject : undefined,
        reason:
          "AWS disruptions are unavailable in simulator mode. Retained operations require recovery in their original supported hosting mode.",
        ...("revert" in before ? { revert: before.revert } : {}),
      });
    } else {
      expect(fixture.ssm).toHaveBeenCalled();
      expect(after?.status).toBe("revert_command_completed");
    }
    await fixture.service.drain();
  },
);
