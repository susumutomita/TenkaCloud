/* eslint-disable sonarjs/no-hardcoded-ip -- Parser vectors and fake guard plans only; no external connections. */
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as transport from "../../lib/node-http";
import { announceHost, localCompetitionEngine } from "../application";
import { DockerHostingEngine } from "../docker-engine";
import { persistentKey, prepareDatabase } from "../files";
import { parseGatewayPorts } from "../gateway-ports";
import type { LocalNetworkGuard } from "../linux-network-guard";
import { definitionKind, type Job } from "../model";
import { parseOptions } from "../options";
import { publishedComposePorts } from "../runtime-ports";
import { startLocalHost } from "../server";
import { HostStore } from "../store";
import { networkEngineFixture } from "./network-engine-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function fixture(args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "tc-lan-isolation-"));
  const options = parseOptions(args, root, {});
  const engine = localCompetitionEngine(root, directory, options);
  const problem = engine.catalog().find((entry) => definitionKind(entry.definition) === "compose");
  if (!problem) throw new Error("Missing Compose catalog fixture.");
  const job: Job = {
    jobId: "lan-fixture",
    eventId: "event",
    teamId: "team",
    problemId: problem.problemId,
    definition: problem.definition,
    offset: 0,
    status: "PENDING",
    unit: null,
  };
  return { engine, job, close: () => rmSync(directory, { recursive: true, force: true }) };
}

const lan = ["--lan", "100.96.12.34", "--unsafe-lan"];

test("production LAN wiring requires Compose isolation without enabling native firewall or Internet exceptions", () => {
  for (const address of ["100.96.12.34", "192.168.20.2"]) {
    const f = fixture(["--lan", address, "--unsafe-lan"]);
    try {
      expect(f.engine.networkRequirement(f.job.definition)).toBe(1);
      expect(f.engine.internetAccessAvailability().available).toBe(false);
    } finally {
      f.close();
    }
  }
  const local = fixture();
  try {
    expect(local.engine.networkRequirement(local.job.definition)).toBeUndefined();
  } finally {
    local.close();
  }
});

for (const operation of ["start", "resume", "recover"] as const)
  test(`LAN ${operation} rejects an unisolated Docker job before touching a daemon or retained state`, async () => {
    const f = fixture(lan);
    const job = { ...f.job, unit: operation === "start" ? null : "synthetic-retained-unit" };
    const before = JSON.stringify(job);
    let retained = false;
    try {
      const result =
        operation === "start"
          ? f.engine.start(job, () => {
              retained = true;
            })
          : f.engine[operation](job);
      await expect(result).rejects.toMatchObject({
        status: 409,
        kind: "network_isolation_required",
      });
      expect(JSON.stringify(job)).toBe(before);
      expect(retained).toBe(false);
    } finally {
      f.close();
    }
  });

test("LAN native problems still start, recover and resume without Docker isolation", async () => {
  const f = fixture(lan);
  const native = f.engine.catalog().find((entry) => entry.problemId === "crypto-battle");
  if (!native) throw new Error("Missing native catalog fixture.");
  const job = { ...f.job, problemId: native.problemId, definition: native.definition };
  try {
    expect(f.engine.networkRequirement(native.definition)).toBeUndefined();
    await f.engine.start(job, (unit) => {
      job.unit = unit;
    });
    expect(JSON.parse(job.unit ?? "{}").kind).toBe("coordination");
    await expect(f.engine.recover(job)).resolves.toBeUndefined();
    await expect(f.engine.resume(job)).resolves.toBeUndefined();
  } finally {
    f.close();
  }
});

for (const explicit of [false, true])
  test(`LAN startup refuses retained unguarded jobs before recovery (explicit native mode: ${explicit})`, () => {
    const f = fixture([
      ...lan,
      ...(explicit ? ["--competition-network", "--docker-network-pool", "10.245.0.0/24"] : []),
    ]);
    try {
      for (const status of ["COMPLETE", "STOPPED", "FAILED", "IN_PROGRESS"] as const) {
        const job = {
          ...f.job,
          status,
          unit: JSON.stringify({ composeProjectName: "tch-lan-fixture" }),
          operation: "restart" as const,
          resumeAfterLocalDown: true,
        };
        const before = JSON.stringify(job);
        let retained = false;
        expect(() =>
          f.engine.bindNetworkState({
            jobs: () => [job],
            retain: () => {
              retained = true;
            },
          }),
        ).toThrow();
        expect(JSON.stringify(job)).toBe(before);
        expect(retained).toBe(false);
      }
    } finally {
      f.close();
    }
  });

test("loopback retains legacy cleanup compatibility and remote native mode admits verified isolated access", async () => {
  const local = fixture();
  try {
    expect(() =>
      local.engine.bindNetworkState({
        jobs: () => [{ ...local.job, unit: "legacy" }],
        retain: () => undefined,
      }),
    ).not.toThrow();
  } finally {
    local.close();
  }
  const f = networkEngineFixture();
  f.engine.requireNetworkIsolation();
  const { job, admitted } = f.add("remote-verified");
  try {
    await admitted;
    expect(f.engine.networkRequirement(job.definition)).toBe(1);
    expect(f.engine.terminalSupported(job)).toBe(true);
    expect(f.engine.surface(job)).toContain("http://127.0.0.1:");
  } finally {
    await f.close();
  }
});

test("real SQLite startup rejects a retained unisolated job before listeners and preserves its state", async () => {
  const f = fixture(lan);
  const directory = mkdtempSync(join(tmpdir(), "tc-lan-retained-"));
  const path = join(directory, "hosting.sqlite");
  prepareDatabase(path);
  persistentKey(join(directory, "host-key"));
  const store = new HostStore(new Database(path));
  // Units written before isolation existed have no isolationVersion.
  const job = {
    ...f.job,
    status: "COMPLETE" as const,
    unit: JSON.stringify({ problemId: f.job.problemId, offset: 0 }),
  };
  const createdAt = new Date(0).toISOString();
  store.putEvent({
    eventId: job.eventId,
    name: "Retained LAN fixture",
    status: "READY",
    createdAt,
    updatedAt: createdAt,
    expiresAt: 2_000_000_000,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  });
  store.putTeam({
    teamId: job.teamId,
    eventId: job.eventId,
    internalSlug: "retained",
    displayName: "Retained",
    loginKey: "synthetic-retained-key",
    snapshot: null,
    score: 0,
    completedProblems: 0,
    scoreEvents: [],
  });
  store.putJob(job);
  store.close();
  let listened = false;
  const listener = spyOn(transport, "listen").mockImplementation(async () => {
    listened = true;
    throw new Error("Unexpected listener opened");
  });
  try {
    await expect(
      startLocalHost(
        root,
        {
          dataDirectory: directory,
          hostname: "127.0.0.1",
          adminPort: 0,
          participantPort: 0,
          gatewayPorts: parseGatewayPorts("22000-22039"),
        },
        (data) => localCompetitionEngine(root, data, parseOptions(lan, root, {})),
        () => undefined,
      ),
    ).rejects.toMatchObject({
      kind: "network_isolation_required",
      message: expect.stringContaining(
        `Retained unisolated Docker environments prevent remote hosting: ${job.problemId}. Start make local without --lan, start it with --unsafe-docker-lan if every participant is trusted, or use Teardown on them in the host console and restart.`,
      ),
    });
    expect(listened).toBe(false);
    const restored = new HostStore(new Database(path));
    try {
      expect(restored.job(job.jobId)).toEqual(job);
    } finally {
      restored.close();
    }
  } finally {
    listener.mockRestore();
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const unsafeDockerLan = [...lan, "--unsafe-docker-lan"];

test("--unsafe-docker-lan is accepted only with --lan and --unsafe-lan", () => {
  expect(parseOptions(unsafeDockerLan, root, {}).unsafeDockerLan).toBe(true);
  expect(parseOptions(lan, root, {}).unsafeDockerLan).toBe(false);
  for (const args of [
    ["--unsafe-docker-lan"],
    ["--lan", "100.96.12.34", "--unsafe-docker-lan"],
    ["--unsafe-lan", "--unsafe-docker-lan"],
  ])
    expect(() => parseOptions(args, root, {})).toThrow(
      "--unsafe-docker-lan requires --lan <private-ip> --unsafe-lan.",
    );
});

test("--unsafe-docker-lan cannot be combined with isolation, VPN or public hosting", () => {
  const combinations = [
    ["--competition-network", "--docker-network-pool", "10.245.0.0/24"],
    ["--vpn-peers", "/etc/tenkacloud/peers.json"],
    [
      "--public-admin-origin",
      "https://admin.example.com",
      "--public-participant-origin",
      "https://play.example.com",
    ],
  ];
  for (const extra of combinations)
    expect(() => parseOptions([...unsafeDockerLan, ...extra], root, {})).toThrow(
      "--unsafe-docker-lan drops team network isolation; it cannot be combined with --competition-network, --vpn-peers, or public origins.",
    );
});

test("--unsafe-docker-lan wiring leaves Docker exercises unisolated and without Internet exceptions", () => {
  const f = fixture(unsafeDockerLan);
  try {
    expect(f.engine.networkRequirement(f.job.definition)).toBeUndefined();
    expect(f.engine.internetAccessAvailability().available).toBe(false);
    expect(() =>
      f.engine.bindNetworkState({
        jobs: () => [{ ...f.job, unit: JSON.stringify({ composeProjectName: "tch-lan-fixture" }) }],
        retain: () => undefined,
      }),
    ).not.toThrow();
  } finally {
    f.close();
  }
});

test("startup warns that Docker exercises have no network isolation only under --unsafe-docker-lan", () => {
  const host = {
    admin: { origin: "https://host.example:5174" },
    participant: { origin: "https://host.example:5175" },
    databasePath: "hosting.sqlite",
  };
  const warnings = (args: string[]) => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      announceHost(parseOptions(args, root, {}), host, false);
      return warn.mock.calls.map(([message]) => String(message));
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  };
  const flagged = warnings(unsafeDockerLan);
  expect(flagged).toHaveLength(2);
  expect(flagged[0]).toStartWith("WARNING: LAN HTTP is unencrypted.");
  expect(flagged[1]).toBe(
    "WARNING: --unsafe-docker-lan gives Docker exercises no network isolation. Each team's exercises can reach other teams' exercises, this host and the LAN. Use it only with participants you trust.",
  );
  expect(warnings(lan)).toHaveLength(1);
});

/** Docker is a PATH stub that records any call; the guard and Compose runner only record calls. */
async function withUnisolatedLan(
  jobId: string,
  run: (f: {
    engine: DockerHostingEngine;
    job: Job;
    calls: string[];
    dockerCalled: () => boolean;
    data: string;
  }) => Promise<void>,
  allowUnisolated = true,
) {
  const data = mkdtempSync(join(tmpdir(), "tc-unsafe-docker-lan-"));
  const bin = join(data, "bin");
  mkdirSync(bin);
  const marker = join(data, "docker-called");
  writeFileSync(join(bin, "docker"), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  const oldCli = process.env.TENKACLOUD_COMPOSE_CLI;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.TENKACLOUD_COMPOSE_CLI = "docker compose";
  const calls: string[] = [];
  const record = (action: string) => () => {
    calls.push(`guard-${action}`);
  };
  const guard: LocalNetworkGuard = {
    preflight: record("preflight"),
    install: record("install"),
    verify: record("verify"),
    verifyNetworks: record("verifyNetworks"),
    remove: record("remove"),
    occupiedRoutes: () => {
      calls.push("guard-occupiedRoutes");
      return [];
    },
    update: record("update"),
    endpoints: () => {
      calls.push("guard-endpoints");
      return [];
    },
    routePublications: record("routePublications"),
    resetStopped: record("resetStopped"),
    quarantine: record("quarantine"),
    stopOwned: async () => {
      calls.push("guard-stopOwned");
    },
  };
  const fetched = spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  try {
    const selected = new DockerHostingEngine(root, data).catalog()[0];
    if (!selected) throw new Error("Missing catalog fixture.");
    const { composeText } = JSON.parse(selected.definition) as { composeText: string };
    const engine = new DockerHostingEngine(
      root,
      data,
      allowUnisolated ? undefined : "10.245.0.0/24",
      false,
      guard,
      async (_u, action) => {
        calls.push(`compose-${action}`);
      },
    );
    if (allowUnisolated) engine.allowUnisolatedDockerLan();
    const job: Job = {
      jobId,
      eventId: "event",
      teamId: "team",
      problemId: selected.problemId,
      definition: selected.definition,
      offset: 0,
      status: "PENDING",
      unit: null,
      runtimePorts: Object.fromEntries(
        publishedComposePorts(composeText).map((port, index) => [String(port), 41_000 + index]),
      ),
    };
    await run({ engine, job, calls, dockerCalled: () => existsSync(marker), data });
  } finally {
    fetched.mockRestore();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldCli === undefined) delete process.env.TENKACLOUD_COMPOSE_CLI;
    else process.env.TENKACLOUD_COMPOSE_CLI = oldCli;
    rmSync(data, { recursive: true, force: true });
  }
}

test("--unsafe-docker-lan start, recover and resume reach Compose without any isolation or guard call", async () => {
  await withUnisolatedLan("unsafe-lan-run", async ({ engine, job, calls }) => {
    await engine.start(job, (unit) => {
      job.unit = unit;
    });
    const unit = JSON.parse(job.unit ?? "{}");
    expect(unit.isolationVersion).toBeUndefined();
    expect(job.networkIsolationVersion).toBeUndefined();
    expect(calls).toEqual(["compose-up"]);
    expect(engine.terminalSupported(job)).toBe(false);
    await engine.resume(job);
    expect(calls).toEqual(["compose-up", "compose-restart"]);
    await expect(engine.recover(job)).rejects.toThrow(
      "The recorded problem environment is not running.",
    );
    expect(calls).toEqual(["compose-up", "compose-restart"]);
  });
});

test("--unsafe-docker-lan running jobs pass the terminal and workbench guards", async () => {
  await withUnisolatedLan("unsafe-lan-guard", async ({ engine, job }) => {
    await engine.start(job, (unit) => {
      job.unit = unit;
    });
    const running = Reflect.get(engine, "running") as Map<string, { problem: object }>;
    const started = running.get(job.jobId);
    if (!started) throw new Error("Job was not admitted.");
    started.problem = { ...started.problem, terminal: { service: "synthetic-shell" } };
    expect(engine.terminalSupported(job)).toBe(true);
    await expect(engine.workbench(job, "starter")).resolves.toEqual({});
  });
});

for (const operation of ["start", "resume", "recover"] as const)
  test(`--unsafe-docker-lan ${operation} refuses an isolation-pinned job before any Docker, Compose or guard call`, async () => {
    for (const pinned of operation === "start" ? (["job"] as const) : (["job", "unit"] as const))
      await withUnisolatedLan(`unsafe-lan-pinned-${operation}-${pinned}`, async (f) => {
        const job: Job = {
          ...f.job,
          ...(pinned === "job" ? { networkIsolationVersion: 1 as const } : {}),
          unit:
            operation === "start"
              ? null
              : JSON.stringify({ composeProjectName: "tch-pinned", isolationVersion: 1 }),
        };
        const before = JSON.stringify(job);
        let retained = false;
        const result =
          operation === "start"
            ? f.engine.start(job, () => {
                retained = true;
              })
            : f.engine[operation](job);
        await expect(result).rejects.toMatchObject({
          status: 409,
          kind: "network_isolation_required",
          message: expect.stringContaining("Create a new event"),
        });
        expect(JSON.stringify(job)).toBe(before);
        expect(retained).toBe(false);
        expect(f.calls).toEqual([]);
        expect(f.dockerCalled()).toBe(false);
      });
  });

test("--unsafe-docker-lan startup recovery fails an isolation-pinned job with the new-event message and leaves its unit", async () => {
  const f = fixture(unsafeDockerLan);
  const directory = mkdtempSync(join(tmpdir(), "tc-unsafe-lan-pinned-"));
  const path = join(directory, "hosting.sqlite");
  prepareDatabase(path);
  persistentKey(join(directory, "host-key"));
  const seed = new HostStore(new Database(path));
  const unit = JSON.stringify({ composeProjectName: "tch-lan-fixture", isolationVersion: 1 });
  const job = {
    ...f.job,
    status: "COMPLETE" as const,
    networkIsolationVersion: 1 as const,
    unit,
  };
  const createdAt = new Date(0).toISOString();
  seed.putEvent({
    eventId: job.eventId,
    name: "Pinned isolation fixture",
    status: "READY",
    createdAt,
    updatedAt: createdAt,
    expiresAt: 2_000_000_000,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
    networkIsolationVersion: 1,
  });
  seed.putTeam({
    teamId: job.teamId,
    eventId: job.eventId,
    internalSlug: "pinned",
    displayName: "Pinned",
    loginKey: "synthetic-pinned-key",
    snapshot: null,
    score: 0,
    completedProblems: 0,
    scoreEvents: [],
  });
  seed.putJob(job);
  seed.close();
  try {
    const host = await startLocalHost(
      root,
      {
        dataDirectory: directory,
        hostname: "127.0.0.1",
        adminPort: 0,
        participantPort: 0,
        gatewayPorts: parseGatewayPorts("22000-22039"),
      },
      (data) => localCompetitionEngine(root, data, parseOptions(unsafeDockerLan, root, {})),
      () => undefined,
    );
    await host.stop();
    const restored = new HostStore(new Database(path));
    try {
      const recovered = restored.job(job.jobId);
      expect(recovered.status).toBe("FAILED");
      expect(recovered.error).toContain("Create a new event");
      expect(recovered.unit).toBe(unit);
    } finally {
      restored.close();
    }
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const operation of ["start", "resume", "recover"] as const)
  test(`loopback ${operation} refuses an isolation-pinned job with one clear message before any Docker, allocation or guard call`, async () => {
    await withUnisolatedLan(
      `loopback-pinned-${operation}`,
      async (f) => {
        const job: Job = {
          ...f.job,
          networkIsolationVersion: 1,
          unit: operation === "start" ? null : JSON.stringify({ composeProjectName: "tch-pinned" }),
        };
        const before = JSON.stringify(job);
        let retained = false;
        const result =
          operation === "start"
            ? f.engine.start(job, () => {
                retained = true;
              })
            : f.engine[operation](job);
        await expect(result).rejects.toMatchObject({
          status: 409,
          kind: "network_isolation_required",
          message: expect.stringMatching(
            /prepared for isolated LAN hosting.*cannot provide that isolation.*Create a new event.*--lan <ip> --unsafe-lan --unsafe-docker-lan/u,
          ),
        });
        expect(JSON.stringify(job)).toBe(before);
        expect(retained).toBe(false);
        expect(f.calls).toEqual([]);
        expect(f.dockerCalled()).toBe(false);
      },
      false,
    );
  });

test("unisolated Docker LAN hosting and required isolation exclude each other", () => {
  const f = fixture(unsafeDockerLan);
  const isolated = fixture(lan);
  try {
    expect(() => f.engine.requireNetworkIsolation()).toThrow(
      "Network isolation cannot be required after unisolated Docker LAN hosting.",
    );
    expect(() => isolated.engine.allowUnisolatedDockerLan()).toThrow(
      "Unisolated Docker LAN hosting cannot be combined with network isolation.",
    );
  } finally {
    isolated.close();
    f.close();
  }
});
