import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { createParticipantAwsFixture } from "./participant-aws-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(withAws = true) {
  const fixture = await createParticipantAwsFixture({ withAws });
  cleanups.push(fixture.close);
  return fixture;
}

test("console and CLI issue only the authenticated team's retained viewer role", async () => {
  const f = await fixture();
  const response = await f.access();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const login = new URL(z.string().parse(response.body.loginUrl));
  expect(login.origin + login.pathname).toBe("https://signin.aws.amazon.com/federation");
  expect(Object.fromEntries(login.searchParams)).toEqual({
    Action: "login",
    Destination: "https://ap-northeast-1.console.aws.amazon.com/console/home?region=ap-northeast-1",
    SigninToken: "viewer-signin-token",
  });
  expect(
    f.calls.map(({ stage, input }) => ({
      stage,
      role: input.RoleArn,
      external: input.ExternalId,
      seconds: input.DurationSeconds,
      session: input.RoleSessionName,
    })),
  ).toEqual([
    {
      stage: "competitor",
      role: "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
      external: "host-external-id-0123456789",
      seconds: 3600,
      session: `tc-${f.alpha.team.teamId.slice(-10)}-${f.alpha.job.jobId}`,
    },
    {
      stage: "participant_viewer",
      role: "arn:aws:iam::111111111111:role/hello-world-viewer-0",
      external: f.alpha.job.jobId,
      seconds: 3600,
      session: `tc-${f.alpha.team.teamId.slice(-10)}-${f.alpha.job.jobId}`,
    },
  ]);
  const federation = f.federation[0];
  if (!federation) throw new Error("Missing federation request");
  const exchange = new URL(federation.url);
  expect(exchange.origin + exchange.pathname).toBe("https://signin.aws.amazon.com/federation");
  expect(federation.init.method).toBe("POST");
  expect(exchange.search).toBe("");
  const tokenBody = new URLSearchParams(String(federation.init.body));
  expect(JSON.parse(tokenBody.get("Session") ?? "null")).toEqual({
    sessionId: "participant_viewer-access",
    sessionKey: "participant_viewer-secret",
    sessionToken: "participant_viewer-token",
  });
  expect(federation.init.redirect).toBe("error");
  const cli = await f.access("cli", f.beta.job.jobId, f.beta.team.loginKey);
  expect(cli.status).toBe(200);
  expect(cli.body).toEqual({
    credentials: {
      accessKeyId: "participant_viewer-access",
      secretAccessKey: "participant_viewer-secret",
      sessionToken: "participant_viewer-token",
      expiration: f.expiry.toISOString(),
      region: "ap-northeast-1",
      awsAccountId: "222222222222",
    },
  });
  expect(f.federation.length).toBe(1);
  expect(f.calls.at(-1)?.input.RoleArn).toBe("arn:aws:iam::222222222222:role/hello-world-viewer-1");
  expect(f.logs).toEqual([]);
});

test("authentication, job ownership and request-selected targets cannot be bypassed", async () => {
  const f = await fixture();
  expect((await f.access("console", f.alpha.job.jobId, "invalid-key")).status).toBe(401);
  expect((await f.access("console", f.beta.job.jobId)).status).toBe(403);
  for (const query of [
    "jobId=bad",
    `jobId=${f.alpha.job.jobId}&jobId=${f.beta.job.jobId}`,
    `jobId=${f.alpha.job.jobId}&roleArn=arn:aws:iam::111111111111:role/Admin`,
    `jobId=${f.alpha.job.jobId}&destination=https://evil.example/`,
    `jobId=${f.alpha.job.jobId}&accountId=222222222222`,
  ])
    expect((await f.get(`/api/portal/me/console-signin-url?${query}`)).status).toBe(400);
  expect(f.calls.length).toBe(0);
});

for (const status of [
  "PENDING",
  "IN_PROGRESS",
  "FAILED",
  "STOPPED",
  "DELETING",
  "DELETED",
] as const) {
  test(`a ${status} environment cannot issue credentials`, async () => {
    const f = await fixture();
    f.store.putJob({ ...f.alpha.job, status });
    expect((await f.access("cli")).status).toBe(409);
    expect(f.calls.length).toBe(0);
  });
}

test("an unconfigured cloud host does not advertise AWS or issue credentials", async () => {
  const disabled = await fixture(false);
  expect((await disabled.get("/runtime-config.json")).body.hasAws).toBe(false);
  expect((await disabled.access()).status).toBe(503);
  const enabled = await fixture();
  expect((await enabled.get("/runtime-config.json")).body.hasAws).toBe(true);
});

for (const stage of ["competitor", "participant_viewer", "federation", "token_body"] as const) {
  test(`ending the event while ${stage} is pending withholds console access`, async () => {
    const f = await fixture();
    f.controls.before = async (current) => {
      if (current === stage) expect((await f.admin("/end")).status).toBe(200);
    };
    const response = await f.access();
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("scoring_ended");
    expect("loginUrl" in response.body).toBe(false);
  });
}

test("key rotation, lock, expiry and job changes during STS all revoke the pending exchange", async () => {
  for (const mutation of ["key", "lock", "expiry", "operation", "unit", "team"] as const) {
    const f = await fixture();
    const mutations = {
      key: async () =>
        expect((await f.admin(`/teams/${f.alpha.team.teamId}/rotate-login-key`)).status).toBe(200),
      lock: async () => expect((await f.admin("/lock-scoring")).status).toBe(200),
      expiry: () => f.store.putEvent({ ...f.store.event(f.eventId), expiresAt: 1 }),
      operation: () => f.store.putJob({ ...f.alpha.job, operation: "teardown" }),
      unit: () => f.store.putJob({ ...f.alpha.job, unit: "{}" }),
      team: () =>
        f.store.putTeam({
          ...f.alpha.team,
          aws: { ...f.alpha.team.aws, accountId: "333333333333" },
        }),
    };
    f.controls.before = async (stage) => {
      if (stage === "competitor") await mutations[mutation]();
    };
    const response = await f.access("cli");
    expect(response.status).toBe(mutation === "key" ? 401 : 409);
    expect("credentials" in response.body).toBe(false);
    expect(f.calls.length).toBe(1);
  }
});

test("malformed, cross-account and deploy-role viewer targets fail before STS", async () => {
  for (const output of [
    undefined,
    "arn:aws:iam::222222222222:role/viewer",
    "arn:aws-us-gov:iam::111111111111:role/viewer",
    "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
    "https://evil.example",
  ]) {
    const f = await fixture();
    const unit = z.record(z.unknown()).parse(JSON.parse(f.alpha.job.unit ?? "null"));
    f.store.putJob({
      ...f.alpha.job,
      unit: JSON.stringify({ ...unit, outputs: { ParticipantViewerRoleArn: output } }),
    });
    expect((await f.access()).status).toBe(409);
    expect(f.calls.length).toBe(0);
  }
});

for (const stage of ["competitor", "participant_viewer"] as const) {
  test(`${stage} failures and missing or expired credentials never expose SDK diagnostics`, async () => {
    for (const failure of ["failed", "missing", "expired"] as const) {
      const f = await fixture();
      f.controls[failure] = stage;
      const response = await f.access("cli");
      expect(response.status).toBe(500);
      expect(response.body.error).toBe("assume_role_failed");
      expect(response.body.stage).toBe(stage);
      expect(JSON.stringify(response.body)).not.toContain("LEAKED_SECRET");
      expect(f.logs).toEqual([]);
      expect(f.federation.length).toBe(0);
    }
  });
}

test("federation failures and malformed tokens never expose secrets or login URLs", async () => {
  for (const failure of ["network", "status", "empty", "number"] as const) {
    const f = await fixture();
    if (failure === "network") f.controls.failed = "federation";
    if (failure === "status") f.controls.federationStatus = 503;
    if (failure === "empty") f.controls.badToken = { SigninToken: "" };
    if (failure === "number") f.controls.badToken = { SigninToken: 123 };
    const response = await f.access();
    expect(response.status).toBe(502);
    expect(response.body.error).toBe(
      ["network", "status"].includes(failure)
        ? "federation_endpoint_failed"
        : "federation_token_malformed",
    );
    expect("loginUrl" in response.body).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(f.logs).toEqual([]);
  }
});

test("event start, lock, expiry and teardown gates prevent AWS calls", async () => {
  const changes = [
    { startsAt: undefined },
    { startsAt: new Date(Date.now() + 60_000).toISOString() },
    { scoringLocked: true },
    { expiresAt: 1 },
    { endsAt: new Date(Date.now() - 1000).toISOString() },
    { status: "TEARDOWN" as const },
    { status: "ARCHIVED" as const },
  ];
  for (const change of changes) {
    const f = await fixture();
    f.store.putEvent({ ...f.store.event(f.eventId), ...change });
    const response = await f.access();
    expect(response.status).toBe(409);
    expect(f.calls.length).toBe(0);
  }
});

test("corrupt units and injected region destinations fail before AWS calls", async () => {
  for (const unit of [
    "{",
    "null",
    "{}",
    JSON.stringify({
      kind: "cloudformation",
      accountId: "111111111111",
      roleArn: "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
      region: "ap-northeast-1.evil.example",
      outputs: { ParticipantViewerRoleArn: "arn:aws:iam::111111111111:role/viewer" },
    }),
  ]) {
    const f = await fixture();
    f.store.putJob({ ...f.alpha.job, unit });
    expect((await f.access()).status).toBe(409);
    expect(f.calls.length).toBe(0);
    expect(f.logs).toEqual([]);
  }
});
