import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Job } from "../model";
import { battleKey, battleOwner, battleSlotFor, connectSimulatorBattle } from "../simulator-battle";

const ENDPOINT = "http://127.0.0.1:4566";
const noop = () => undefined;
const HINT = "ec2-10-0-1-5.ap-northeast-1.compute.simulator.invalid";

// Copied from TenkaCloudSimulator internal/server/testdata/battle-deployment-key-v1.json: the
// host must derive the same owner key as the Simulator's battleKey.
const simulatorKeyVectors = [
  {
    owner: {
      eventId: "event",
      teamId: "team",
      jobId: "job",
      unitHash: "ab".repeat(32),
      deployedAt: 1700000000000,
      stackId: "stack",
      instanceId: "i-1",
    },
    key: "083159aafb52d5d93188d2e3d0bd6e2ac06667d1dbb1949e3c347d9075a886b8",
  },
  {
    owner: {
      eventId: "大会<&>\u2028inside",
      teamId: "é😀",
      jobId: "j:2",
      unitHash: "cd".repeat(32),
      deployedAt: 9007199254740991,
      stackId: "arn:stack/日本",
      instanceId: "i-2",
    },
    key: "4f4e075e351584ec095aab31b9dcb7f7e65ddf447994f2b24385d0c5e1e2d271",
  },
];

test("owner keys match the Simulator's length-prefixed battleKey vectors", () => {
  for (const vector of simulatorKeyVectors) expect(battleKey(vector.owner)).toBe(vector.key);
});

function battleJob(overrides: Partial<Job> = {}): Job {
  const unit = JSON.stringify({
    kind: "cloudformation",
    accountId: "000000000000",
    roleArn: "arn:aws:iam::000000000000:role/TenkaCloud-SimulatorDeploy-Role",
    region: "ap-northeast-1",
    stackName: "tc-hello-world-battle-alpha-0123456789ab",
    stackId: "arn:aws:cloudformation:ap-northeast-1:000000000000:stack/tc-hello-world-battle/1",
    outputs: { Ec2HostHint: HINT, InstanceId: "i-0123456789abcdef0" },
  });
  const job: Job = {
    jobId: "job-1",
    eventId: "event-1",
    teamId: "team-1",
    problemId: "hello-world-battle",
    definition: "{}",
    offset: 0,
    status: "COMPLETE",
    deployedAt: 1_700_000_000_000,
    unit,
    ...overrides,
  };
  return job;
}

test("the owner is the deployment's immutable identity and exists only for a completed stack", () => {
  const job = battleJob();
  expect(battleOwner(job)).toEqual({
    eventId: "event-1",
    teamId: "team-1",
    jobId: "job-1",
    unitHash: createHash("sha256")
      .update(job.unit ?? "")
      .digest("hex"),
    deployedAt: 1_700_000_000_000,
    stackId: "arn:aws:cloudformation:ap-northeast-1:000000000000:stack/tc-hello-world-battle/1",
    instanceId: "i-0123456789abcdef0",
  });
  expect(battleOwner(battleJob({ status: "IN_PROGRESS" }))).toBeUndefined();
  expect(battleOwner(battleJob({ unit: JSON.stringify({ outputs: {} }) }))).toBeUndefined();
});

test("only the deployment's own host, port and path select a slot", () => {
  expect(battleSlotFor(`http://${HINT}/`, HINT)?.slot).toBe("frontend");
  expect(battleSlotFor(`http://${HINT}:80/`, HINT)?.slot).toBe("frontend");
  expect(battleSlotFor(`http://${HINT}:8080/healthz`, HINT)?.slot).toBe("api");
  for (const url of [
    `http://${HINT}:8080/`,
    `http://${HINT}/healthz`,
    `https://${HINT}/`,
    `http://other.simulator.invalid/`,
    `http://user@${HINT}/`,
    `http://${HINT}/?x=1`,
    "not a url",
  ])
    expect(battleSlotFor(url, HINT)).toBeUndefined();
});

interface Recorded {
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

function fakeSimulator(responses: Record<string, (body: unknown) => Response>) {
  const calls: Recorded[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ path, body, headers: (init.headers ?? {}) as Record<string, string> });
    const handler =
      responses[path] ??
      Object.entries(responses).find(
        ([prefix]) => prefix.endsWith("*") && path.startsWith(prefix.slice(0, -1)),
      )?.[1];
    return handler ? handler(body) : new Response("not found", { status: 404 });
  };
  return { calls, fetchFn };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const available = () => json({ configured: true, protocolVersion: 1, clockDomain: "tc-clock" });
const receipt = () =>
  json({
    version: 1,
    handle: "h1",
    clockDomain: "tc-clock",
    binding: {
      endpoints: {
        frontend: `${ENDPOINT}/_simulator/v1/battle-capabilities/h1/frontend`,
        api: `${ENDPOINT}/_simulator/v1/battle-capabilities/h1/api`,
      },
    },
    slots: {
      frontend: { wireBinding: { w: 1 }, service: { name: "frontend", path: "/", port: 80 } },
      api: { wireBinding: { w: 2 }, service: { name: "api", path: "/healthz", port: 8080 } },
    },
  });

test("a failed availability check is an error, not a Simulator without Battle", async () => {
  for (const response of [
    () => new Response("denied", { status: 403 }),
    () => new Response("<xml/>", { status: 200 }),
  ]) {
    const { fetchFn } = fakeSimulator({
      "/_simulator/v1/battle-capabilities/availability": response,
    });
    await expect(connectSimulatorBattle(ENDPOINT, "token", noop, fetchFn)).rejects.toThrow();
  }
});

test("an unconfigured or older Simulator offers no Battle runtime", async () => {
  for (const response of [
    () => json({ configured: false, protocolVersion: 1, clockDomain: "c" }),
    () => json({ configured: true, protocolVersion: 2, clockDomain: "c" }),
    () => new Response("not found", { status: 404 }),
  ]) {
    const { fetchFn } = fakeSimulator({
      "/_simulator/v1/battle-capabilities/availability": response,
    });
    expect(await connectSimulatorBattle(ENDPOINT, "token", noop, fetchFn)).toBeUndefined();
  }
});

test("a probe resolves the owner once, starts and reads a settled observation", async () => {
  let reads = 0;
  const { calls, fetchFn } = fakeSimulator({
    "/_simulator/v1/battle-capabilities/availability": available,
    "/_simulator/v1/battle-capabilities/resolve": receipt,
    "/_simulator/v1/battle-capabilities/h1/frontend/start": () => json({ resultReady: false }),
    "/_simulator/v1/battle-capabilities/h1/frontend/read": () =>
      json(
        ++reads < 2
          ? { resultReady: false }
          : {
              resultReady: true,
              settled: true,
              result: { error: null, observation: { status: 200, path: "/" } },
            },
      ),
    "/_simulator/v1/battle-capabilities/h1/api/start": () =>
      json({
        resultReady: true,
        settled: true,
        result: { error: "probe_failed", observation: null },
      }),
  });
  let now = 1_000_000;
  const battle = await connectSimulatorBattle(
    ENDPOINT,
    "operator-token",
    noop,
    fetchFn,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  const job = battleJob();
  const probe = battle?.probe(job);
  expect(probe).toBeDefined();
  expect(await probe?.(`http://${HINT}/`, { expectStatus: [200] })).toMatchObject({
    ok: true,
    status: 200,
  });
  // A settled failure (stopped nginx) is a failed probe, not an error.
  expect(await probe?.(`http://${HINT}:8080/healthz`, { expectStatus: [200] })).toMatchObject({
    ok: false,
  });
  // Another URL never reaches the Simulator.
  expect(await probe?.("http://example.com/", {})).toMatchObject({ ok: false });
  const resolves = calls.filter((call) => call.path.endsWith("/resolve"));
  expect(resolves).toHaveLength(1);
  const owner = battleOwner(job);
  expect(resolves[0]?.body).toEqual({
    version: 1,
    owner,
    key: battleKey(owner ?? (owner as never)),
  });
  const start = calls.find((call) => call.path.endsWith("/frontend/start"));
  expect(start?.body).toMatchObject({
    version: 1,
    command: "start",
    binding: { w: 1 },
    service: "frontend",
    deadline: { domain: "tc-clock" },
  });
  expect(calls.every((call) => call.headers["X-Simulator-Token"] === "operator-token")).toBe(true);
});

test("Simulator errors and unsettled probes are errors, never a participant failure", async () => {
  const resolveRefused = fakeSimulator({
    "/_simulator/v1/battle-capabilities/availability": available,
    "/_simulator/v1/battle-capabilities/resolve": () => new Response("x", { status: 409 }),
  });
  const refused = await connectSimulatorBattle(ENDPOINT, "t", noop, resolveRefused.fetchFn);
  await expect(refused?.probe(battleJob())?.(`http://${HINT}/`)).rejects.toThrow("receipt");
  let now = 0;
  const neverSettles = fakeSimulator({
    "/_simulator/v1/battle-capabilities/availability": available,
    "/_simulator/v1/battle-capabilities/resolve": receipt,
    "/_simulator/v1/battle-capabilities/h1/*": () => json({ resultReady: false }),
  });
  const slow = await connectSimulatorBattle(
    ENDPOINT,
    "t",
    noop,
    neverSettles.fetchFn,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  await expect(slow?.probe(battleJob())?.(`http://${HINT}/`)).rejects.toThrow("settle");
});

test("seal tolerates a never-registered guest but reports other failures", async () => {
  for (const [status, rejects] of [
    [200, false],
    [409, false],
    [500, true],
  ] as const) {
    const { fetchFn } = fakeSimulator({
      "/_simulator/v1/battle-capabilities/availability": available,
      "/_simulator/v1/battle-capabilities/seal": () => json({ sealed: true }, status),
    });
    const battle = await connectSimulatorBattle(ENDPOINT, "t", noop, fetchFn);
    if (rejects) await expect(battle?.seal(battleJob())).rejects.toThrow("seal");
    else await battle?.seal(battleJob());
  }
});

test("terminal codes are signed with the participant's viewer credentials and validated", async () => {
  const now = Date.now();
  const { calls, fetchFn } = fakeSimulator({
    "/_simulator/v1/battle-capabilities/availability": available,
    "/_simulator/v1/terminal-handoffs": () =>
      json({ Code: "a".repeat(64), ExpiresAt: new Date(now + 60_000).toISOString() }),
  });
  const battle = await connectSimulatorBattle(ENDPOINT, "operator-token", noop, fetchFn);
  const credentials = {
    accessKeyId: "ASIAVIEWER",
    secretAccessKey: "secret",
    sessionToken: "session",
    expiration: new Date(now + 3_600_000),
  };
  const handoff = await battle?.terminal(
    { credentials, instanceId: "i-0123456789abcdef0", region: "ap-northeast-1" },
    noop,
  );
  expect(handoff).toEqual({
    code: "a".repeat(64),
    terminalUrl: `${ENDPOINT}/_simulator/terminal`,
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const request = calls.find((call) => call.path === "/_simulator/v1/terminal-handoffs");
  expect(request?.body).toEqual({ Target: "i-0123456789abcdef0", Region: "ap-northeast-1" });
  expect(request?.headers.authorization).toContain("Credential=ASIAVIEWER/");
  expect(request?.headers.authorization).toContain("/ap-northeast-1/sts/aws4_request");
  expect(request?.headers["X-Simulator-Token"]).toBeUndefined();
  await expect(
    battle?.terminal(
      { credentials, instanceId: "not-an-instance", region: "ap-northeast-1" },
      noop,
    ),
  ).rejects.toMatchObject({ status: 409 });
});
