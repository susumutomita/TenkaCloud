import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { id } from "../auth";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { connectCloudHosting } from "../cloud-hosting";
import { unitOf } from "../cloud-runtime-contract";
import type { AccountConnection, Job } from "../model";
import { parseOptions } from "../options";
import { HostingService } from "../service";
import { authorityUnavailable, sameAuthority } from "../simulator-authority";
import {
  connectSimulatorConnections,
  loadSimulatorConnections,
  simulatorConnections,
} from "../simulator-connections";
import { HostStore } from "../store";
import { uptimeGeneration } from "../uptime";
import { FakeAws } from "./fake-aws";
import { HistoricalCompetitionEngine } from "./historical-competition-fixture";
import { bootstrapOrganizer } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const accountId = "000000000000";
const alpha = { authorityId: "alpha", generation: 1 };
const beta = { authorityId: "beta", generation: 1 };
const directories: string[] = [];
const stores: HostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "tc-account-entry-"));
  directories.push(path);
  return path;
}
async function fixture(withBattle = false) {
  const data = directory();
  const transports = [new FakeAws(), new FakeAws()];
  const terminalCalls: string[] = [];
  const entries = await Promise.all(
    [alpha, beta].map(async (binding, index) => {
      const aws = transports[index];
      if (!aws) throw new Error("Missing fake transport");
      const connection = await connectCloudHosting(root, data, "ap-northeast-1", {
        sts: aws.sts as never,
        cloudFormation: aws.cloudFormation as never,
        ...(withBattle
          ? {
              simulatorServices: ["sts", "iam", "cloudformation", "ssm"],
              simulatorBattle: {
                clockDomain: "synthetic-clock",
                probe: () => async () => ({ ok: true, status: 200, responseTimeMs: 1 }),
                seal: async () => undefined,
                terminal: async (_input, assertCurrent) => {
                  assertCurrent();
                  terminalCalls.push(binding.authorityId);
                  return {
                    code: "synthetic-terminal",
                    terminalUrl: `http://127.0.0.1:${4500 + index}/terminal`,
                    expiresAt: new Date(Date.now() + 60000).toISOString(),
                  };
                },
              },
            }
          : {}),
        simulatorAuthority: binding,
        simulatorEndpoint: `http://127.0.0.1:${4500 + index}`,
      });
      return {
        binding,
        connection: {
          ...connection,
          simulator: {
            endpoint: `http://127.0.0.1:${4500 + index}`,
            region: connection.region,
            awsAccountId: accountId,
            bootstrapRoleName: "TenkaCloud-SimulatorDeploy-Role",
          },
        },
      };
    }),
  );
  const connection = simulatorConnections(entries);
  const path = join(data, "test.sqlite");
  const store = new HostStore(new Database(path));
  stores.push(store);
  const service = new HostingService(
    store,
    new HistoricalCompetitionEngine(
      root,
      data,
      true,
      connection.engine((job) => store.team(job.teamId)),
    ),
    HOST_KEY,
  );
  service.accountConnection = connection;
  const token = await bootstrapOrganizer(service, HOST_KEY);
  const request = (method: string, path: string, body?: unknown, binding?: typeof alpha) =>
    service.admin(
      apiRequest({
        method,
        path,
        token,
        ...(body === undefined ? {} : { body }),
        query: new URLSearchParams(
          binding
            ? { authorityId: binding.authorityId, generation: String(binding.generation) }
            : {},
        ),
      }),
    );
  const register = (binding?: typeof alpha) =>
    request("POST", "/admin/competitor-accounts", {
      awsAccountId: accountId,
      ...(binding ? { simulatorAuthority: binding } : {}),
    });
  const verify = (binding?: typeof alpha) =>
    request("POST", `/admin/competitor-accounts/${accountId}/verify`, {}, binding);
  return {
    data,
    terminalCalls,
    path,
    store,
    service,
    token,
    request,
    register,
    verify,
    transports,
    entries,
    connection,
  };
}

test("explicit external configuration is private, strict, exclusive and never starts a managed Simulator", () => {
  const data = directory();
  const path = join(data, "connections.json");
  const connections = [alpha, beta].map((binding, index) => ({
    ...binding,
    endpoint: `http://127.0.0.1:${4500 + index}`,
    region: "ap-northeast-1",
    tokenFile: `${binding.authorityId}.token`,
  }));
  const write = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write({ version: 1, connections });
  const settings = loadSimulatorConnections(path);
  expect(settings.map((entry) => entry.authority)).toEqual([alpha, beta]);
  expect(settings[0]).toHaveProperty("tokenFile", join(data, "alpha.token"));
  expect(parseOptions(["--simulator-connections", path], root, {})).not.toHaveProperty(
    "managedSimulator",
  );
  for (const args of [
    ["--no-simulator"],
    ["--simulator-token", "synthetic"],
    ["--simulator-bootstrap"],
    ["--battle-bundle", "unused"],
    ["--update-simulator"],
    ["--simulator-binary", "unused"],
    ["--lan", [10, 0, 0, 1].join("."), "--unsafe-lan"],
  ])
    expect(() => parseOptions(["--simulator-connections", path, ...args], root, {})).toThrow();
  for (const invalid of [
    { version: 2, connections },
    { version: 1, connections: [] },
    { version: 1, connections: [connections[0], connections[0]] },
    { version: 1, connections: [{ ...connections[0], token: "private-do-not-print" }] },
    {
      version: 1,
      connections: [{ ...connections[0], endpoint: "https://remote.invalid/private-do-not-print" }],
    },
  ]) {
    write(invalid);
    expect(() => loadSimulatorConnections(path)).toThrow(
      "Invalid private Simulator connections file",
    );
    try {
      loadSimulatorConnections(path);
    } catch (error) {
      expect(String(error)).not.toContain("private-do-not-print");
    }
  }
  write({ version: 1, connections });
  chmodSync(path, 0o644);
  expect(() => loadSimulatorConnections(path)).toThrow();
  chmodSync(path, 0o600);
  const linked = join(data, "link.json");
  symlinkSync(path, linked);
  expect(() => loadSimulatorConnections(linked)).toThrow();
  rmSync(linked);
  linkSync(path, linked);
  expect(() => loadSimulatorConnections(path)).toThrow();
});

test("same-account registrations and verification select two independent whole transports", async () => {
  const f = await fixture();
  await f.register(alpha);
  await f.register(beta);
  await f.verify(alpha);
  expect(f.transports.map((aws) => aws.assumed.length)).toEqual([1, 0]);
  expect(f.store.account(accountId, alpha).verified).toBe(true);
  expect(f.store.account(accountId, beta).verified).toBe(false);
  await f.verify(beta);
  expect(f.transports.map((aws) => aws.assumed.length)).toEqual([1, 1]);
  expect(f.transports[0]?.assumed[0]?.RoleArn).toBe(f.transports[1]?.assumed[0]?.RoleArn);
  const response = await f.request("GET", "/admin/competitor-accounts");
  expect(JSON.stringify(response)).not.toMatch(/endpoint|tokenFile|externalId|4500|4501/u);
  expect(f.store.accounts()).toHaveLength(2);
  await f.request("DELETE", `/admin/competitor-accounts/${accountId}`, undefined, alpha);
  expect(f.store.accounts()).toHaveLength(1);
  await f.verify(beta);
  expect(f.store.account(accountId, beta).verified).toBe(true);
});

test("missing, partial, unknown and generation-mismatched selectors reject before transport", async () => {
  const f = await fixture();
  await f.register(alpha);
  for (const binding of [
    undefined,
    { authorityId: "unknown", generation: 1 },
    { ...alpha, generation: 2 },
  ]) {
    await expect(f.register(binding)).rejects.toMatchObject({ status: 409 });
    await expect(f.verify(binding)).rejects.toMatchObject({ status: 409 });
  }
  await expect(
    f.service.admin(
      apiRequest({
        method: "POST",
        path: `/admin/competitor-accounts/${accountId}/verify`,
        token: f.token,
        query: new URLSearchParams({ authorityId: "alpha" }),
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.transports.map((aws) => aws.assumed.length)).toEqual([0, 0]);
});

for (const revoke of ["authority", "generation", "registration", "permission"] as const)
  test(`verify ${revoke} revocation during await cannot persist success`, async () => {
    const f = await fixture();
    await f.register(alpha);
    await f.register(beta);
    const leaf = f.connection.selectAuthority?.(alpha);
    if (!leaf) throw new Error("Missing alpha");
    const original = leaf.verify;
    leaf.verify = async (...args) => {
      await original(...args);
      if (revoke === "registration") {
        f.store.deleteAccount(accountId, alpha);
        f.store.putAccount({
          ...f.store.account(accountId, beta),
          simulatorAuthority: alpha,
          registrationId: "replacement",
        });
      } else if (revoke === "permission") f.store.rotateLocalOrganizerKey();
      else if (revoke === "generation") {
        const entry = f.entries[0];
        if (!entry) throw new Error("Missing alpha entry");
        entry.binding = { ...alpha, generation: 2 };
      } else {
        const changed: AccountConnection = {
          ...f.connection,
          selectAuthority: (binding) => {
            if (sameAuthority(binding, alpha)) throw authorityUnavailable();
            return f.connection.selectAuthority?.(binding) ?? leaf;
          },
        };
        f.service.accountConnection = changed;
      }
    };
    await expect(f.verify(alpha)).rejects.toMatchObject({
      status: revoke === "permission" ? 401 : 409,
    });
    expect(f.store.account(accountId, alpha).verified).toBe(false);
    expect(f.store.account(accountId, beta).verified).toBe(false);
    expect(f.transports.map((aws) => aws.assumed.length)).toEqual([1, 0]);
  });

test("one event persists both verified team bindings and restores their original runtime authority", async () => {
  const f = await fixture();
  await f.register(alpha);
  await f.register(beta);
  await f.verify(alpha);
  await f.verify(beta);
  const body = {
    name: "bound teams",
    problems: [{ problemId: "hello-world" }],
    teams: [alpha, beta].map((binding) => ({
      internalSlug: binding.authorityId,
      awsAccountId: accountId,
      simulatorAuthority: binding,
    })),
  };
  await expect(
    f.request("POST", "/events", {
      ...body,
      teams: [{ internalSlug: "missing", awsAccountId: accountId }],
    }),
  ).rejects.toMatchObject({ status: 409 });
  const response = await f.request("POST", "/events", body);
  const { eventId } = response.body as { eventId: string };
  expect(f.store.teams(eventId).map((team) => team.aws?.simulatorAuthority)).toEqual([alpha, beta]);
  await expect(
    f.request("DELETE", `/admin/competitor-accounts/${accountId}`, undefined, alpha),
  ).rejects.toMatchObject({ status: 409 });
  await f.request("POST", `/events/${eventId}/deploy`);
  await f.service.drain();
  expect(f.store.jobs(eventId).map((job) => job.status)).toEqual(["COMPLETE", "COMPLETE"]);
  expect(f.store.jobs(eventId).map((job) => unitOf(job).simulatorAuthority)).toEqual([alpha, beta]);
  // Reopen SQLite and rebuild engines from the same explicit external connections.
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const reopened = new HostStore(new Database(f.path));
  stores.push(reopened);
  const engines = f.connection.engine((job) => reopened.team(job.teamId));
  const jobs = reopened.jobs(eventId);
  for (const job of jobs)
    expect(unitOf(job).simulatorAuthority).toEqual(
      reopened.team(job.teamId).aws?.simulatorAuthority,
    );
  const betaJob = jobs[1];
  if (!betaJob) throw new Error("Missing beta job");
  const twins = f.transports.map((aws) =>
    aws.seedStack("same-native-resource", [{ Key: "tenkacloud:job", Value: betaJob.jobId }]),
  );
  expect(twins[0]?.stackId).toBe(twins[1]?.stackId);
  const retained = unitOf(betaJob);
  betaJob.unit = JSON.stringify({
    ...retained,
    stackName: "same-native-resource",
    stackId: twins[0]?.stackId,
  });
  const counts = f.transports.map((aws) => aws.assumed.length);
  await engines.recover(betaJob);
  expect(f.transports[0]?.assumed.length).toBe(counts[0]);
  expect(f.transports[1]?.assumed.length).toBeGreaterThan(counts[1] ?? 0);
});

test("legacy unused unbound accounts can still be deleted without a cloud connection", async () => {
  const f = await fixture();
  const now = new Date().toISOString();
  f.store.putAccount({
    awsAccountId: accountId,
    region: "ap-northeast-1",
    competitorRoleName: "LegacyRole",
    verified: true,
    createdAt: now,
    updatedAt: now,
  });
  f.service.accountConnection = undefined;
  await f.request("DELETE", `/admin/competitor-accounts/${accountId}`);
  expect(f.store.accounts()).toEqual([]);
  expect(f.transports.map((aws) => aws.assumed.length)).toEqual([0, 0]);
});

test("bulk binding rejection is invalid rather than a false duplicate", async () => {
  const f = await fixture();
  const response = await f.request("POST", "/admin/competitor-accounts/bulk", {
    accounts: [
      { awsAccountId: accountId },
      { awsAccountId: accountId, simulatorAuthority: alpha },
      { awsAccountId: accountId, simulatorAuthority: alpha },
      { awsAccountId: accountId, simulatorAuthority: beta },
    ],
  });
  expect(response.body).toMatchObject({ created: 2, invalid: 1, duplicate: 1, failed: 0 });
  expect(JSON.stringify(response.body)).not.toMatch(/endpoint|tokenFile|externalId/u);
});

test("all external bindings are checked before any token read or connection", async () => {
  let reads = 0;
  await expect(
    connectSimulatorConnections(root, directory(), [
      {
        endpoint: "http://127.0.0.1:4566",
        region: "ap-northeast-1",
        readToken: () => {
          reads += 1;
          throw new Error("must not read");
        },
      },
    ]),
  ).rejects.toMatchObject({ status: 409 });
  expect(reads).toBe(0);
});

test("a single configured authority still requires explicit binding and cannot adopt legacy records", async () => {
  const f = await fixture();
  const entry = f.entries[0];
  if (!entry) throw new Error("Missing alpha");
  f.service.accountConnection = simulatorConnections([entry]);
  const now = new Date().toISOString();
  f.store.putAccount({
    awsAccountId: accountId,
    competitorRoleName: "SameRole",
    region: "ap-northeast-1",
    verified: true,
    createdAt: now,
    updatedAt: now,
  });
  await expect(f.register()).rejects.toMatchObject({ status: 409 });
  await expect(f.verify()).rejects.toMatchObject({ status: 409 });
  await f.register(alpha);
  expect(f.store.accounts()).toHaveLength(2);
  expect(f.store.account(accountId).verified).toBe(true);
  expect(f.store.account(accountId, alpha).verified).toBe(false);
});

/** Synthetic Host API regression: equal AWS/native IDs do not choose endpoint authority. */
async function participantFixture() {
  const f = await fixture(true);
  await f.register(alpha);
  await f.register(beta);
  await f.verify(alpha);
  await f.verify(beta);
  const created = await f.request("POST", "/events", {
    name: "participant authority",
    problems: [{ problemId: "hello-world-battle" }],
    teams: [alpha, beta].map((binding) => ({
      internalSlug: binding.authorityId,
      awsAccountId: accountId,
      simulatorAuthority: binding,
    })),
  });
  const { eventId } = created.body as { eventId: string };
  const event = f.store.event(eventId);
  const now = Date.now();
  f.store.putEvent({ ...event, status: "READY", startsAt: new Date(now - 1000).toISOString() });
  const problem = event.problems[0];
  if (!problem) throw new Error("Missing Battle problem");
  const lanes = f.store.teams(eventId).map((team) => {
    const job: Job = {
      jobId: id(),
      teamId: team.teamId,
      eventId,
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      deployedAt: now - 1000,
      unit: JSON.stringify({
        kind: "cloudformation",
        simulatorAuthority: team.aws?.simulatorAuthority,
        accountId,
        roleArn: `arn:aws:iam::${accountId}:role/TenkaCloud-SimulatorDeploy-Role`,
        region: "ap-northeast-1",
        stackName: "same-native-stack",
        stackId: `arn:aws:cloudformation:ap-northeast-1:${accountId}:stack/same-native-stack/0`,
        outputs: {
          ParticipantViewerRoleArn: `arn:aws:iam::${accountId}:role/SameViewerRole`,
          Ec2HostHint: "ec2-10-0-1-5.ap-northeast-1.compute.simulator.invalid",
          InstanceId: "i-00000000000000001",
        },
      }),
    };
    f.store.putJob(job);
    f.store.putUptimeState(eventId, team.teamId, problem.problemId, {
      ...f.store.uptimeState(eventId, team.teamId, problem.problemId),
      generation: uptimeGeneration(job),
      readyAt: now,
    });
    const access = (kind: "cli-credentials" | "guest-terminal", target = job.jobId) =>
      f.service.participant(
        apiRequest({
          method: "GET",
          path: `/portal/me/${kind}`,
          token: team.loginKey,
          query: new URLSearchParams({ jobId: target }),
        }),
      );
    return { team, job, access };
  });
  return { ...f, lanes };
}

for (const change of ["removed", "generation", "during-credentials"] as const)
  test(`participant URLs remain own-authority only and ${change} revocation denies issuance`, async () => {
    const f = await participantFixture();
    const a = f.lanes[0];
    const b = f.lanes[1];
    if (!a || !b) throw new Error("Missing participant lanes");
    for (const [lane, index] of [
      [a, 0],
      [b, 1],
    ] as const) {
      const cli = await lane.access("cli-credentials");
      expect(cli.body).toMatchObject({
        credentials: { endpointUrl: `http://127.0.0.1:${4500 + index}` },
      });
      expect(JSON.stringify(cli.body)).not.toContain(`http://127.0.0.1:${4501 - index}`);
      const terminal = await lane.access("guest-terminal");
      expect(terminal.body).toMatchObject({
        terminalUrl: `http://127.0.0.1:${4500 + index}/terminal`,
      });
      expect(JSON.stringify(terminal.body)).not.toMatch(/tokenFile|alpha\.token|beta\.token/u);
    }
    const beforeForeign = f.transports.map((aws) => aws.assumed.length);
    const terminalCount = f.terminalCalls.length;
    for (const [caller, other] of [
      [a, b],
      [b, a],
    ] as const)
      for (const kind of ["cli-credentials", "guest-terminal"] as const)
        await expect(caller.access(kind, other.job.jobId)).rejects.toMatchObject({
          status: 403,
          kind: "unauthorized",
        });
    expect(f.transports.map((aws) => aws.assumed.length)).toEqual(beforeForeign);
    expect(f.terminalCalls).toHaveLength(terminalCount);
    const revoke = () => {
      if (change === "removed") f.entries.splice(1, 1);
      else {
        const entry = f.entries[1];
        if (!entry) throw new Error("Missing beta entry");
        entry.binding = { ...beta, generation: 2 };
      }
    };
    if (change === "during-credentials") {
      const aws = f.transports[1];
      if (!aws) throw new Error("Missing beta transport");
      const send = aws.sts.send;
      aws.sts.send = async (command) => {
        const response = await send(command);
        revoke();
        return response;
      };
    } else revoke();
    await expect(b.access("cli-credentials")).rejects.toMatchObject({ status: 409 });
    await expect(b.access("guest-terminal")).rejects.toMatchObject({ status: 409 });
    expect(f.terminalCalls).toHaveLength(terminalCount);
    expect((await a.access("cli-credentials")).body).toMatchObject({
      credentials: { endpointUrl: "http://127.0.0.1:4500" },
    });
  });
