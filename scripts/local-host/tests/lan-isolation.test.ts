/* eslint-disable sonarjs/no-hardcoded-ip -- Parser vectors and fake guard plans only; no external connections. */
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as transport from "../../lib/node-http";
import { localCompetitionEngine } from "../application";
import { persistentKey, prepareDatabase } from "../files";
import { parseGatewayPorts } from "../gateway-ports";
import { definitionKind, type Job } from "../model";
import { parseOptions } from "../options";
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
        `Retained unisolated Docker environments prevent remote hosting: ${job.problemId}. Start make local without --lan`,
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
