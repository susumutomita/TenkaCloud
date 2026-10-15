import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDockerCatalog } from "../docker-catalog";
import { DockerHostingEngine } from "../docker-engine";
import type { LocalNetworkGuard } from "../linux-network-guard";
import type { Job } from "../model";
import { publishedComposePorts } from "../runtime-ports";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

// Docker is a PATH stub and the guard only records calls; no daemon or firewall is touched.
async function withStart(
  jobId: string,
  guardFor: (calls: string[]) => Partial<LocalNetworkGuard>,
  run: (f: {
    engine: DockerHostingEngine;
    job: Job;
    data: string;
    calls: string[];
    retained: (string | null)[];
    retain: (unit: string | null) => void;
  }) => Promise<void>,
) {
  const data = mkdtempSync(join(tmpdir(), "tenka-start-rollback-synthetic-"));
  const bin = join(data, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const oldPath = process.env.PATH;
  const oldCli = process.env.TENKACLOUD_COMPOSE_CLI;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.TENKACLOUD_COMPOSE_CLI = "docker compose";
  const calls: string[] = [];
  const record = (action: string) => () => {
    calls.push(action);
  };
  const guard: LocalNetworkGuard = {
    preflight: record("preflight"),
    install: record("install"),
    verify: record("verify"),
    verifyNetworks: record("verifyNetworks"),
    remove: record("remove"),
    occupiedRoutes: () => [],
    update: record("update"),
    endpoints: () => [],
    routePublications: record("route"),
    resetStopped: record("reset"),
    quarantine: record("quarantine"),
    stopOwned: async () => {
      calls.push("stop-owned");
    },
    ...guardFor(calls),
  };
  try {
    const selected = loadDockerCatalog(repository)[0];
    if (!selected) throw new Error("Missing catalog fixture.");
    const { composeText } = JSON.parse(selected.definition) as { composeText: string };
    const engine = new DockerHostingEngine(
      repository,
      data,
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic allocator pool, no connection
      "10.247.0.0/22",
      true,
      guard,
      async (_unit, action) => {
        calls.push(`compose-${action}`);
      },
    );
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
        publishedComposePorts(composeText).map((port, index) => [String(port), 30_000 + index]),
      ),
    };
    const retained: (string | null)[] = [];
    await run({
      engine,
      job,
      data,
      calls,
      retained,
      retain: (unit) => {
        retained.push(unit);
        job.unit = unit;
      },
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldCli === undefined) delete process.env.TENKACLOUD_COMPOSE_CLI;
    else process.env.TENKACLOUD_COMPOSE_CLI = oldCli;
    rmSync(data, { recursive: true, force: true });
  }
}

test("an isolated start whose secret preparation fails retains no ownership, reservation or guard", async () => {
  await withStart(
    "secret-rollback",
    () => ({}),
    async ({ engine, job, data, calls, retained, retain }) => {
      // A directory where the master secret file belongs makes secret preparation fail.
      mkdirSync(join(data, "runtimes", job.jobId, "problem-secrets.key"), {
        recursive: true,
        mode: 0o700,
      });
      await expect(engine.start(job, retain)).rejects.toThrow("EISDIR");
      expect(
        retained.map((unit) =>
          unit === null ? "released" : (JSON.parse(unit).teardown ?? "owned"),
        ),
      ).toEqual(["owned", "down", "released"]);
      expect(job.unit).toBeNull();
      expect((Reflect.get(engine, "networkReservations") as Map<string, unknown>).size).toBe(0);
      expect(calls).not.toContain("install");
      expect(calls).not.toContain("compose-up");
      expect(existsSync(join(data, "runtimes", job.jobId, "tch-secret-rollback.compose.yml"))).toBe(
        false,
      );
    },
  );
});

test("a failed start whose guard removal fails after Compose down resumes from guard removal", async () => {
  let down = false;
  let removals = 0;
  await withStart(
    "removal-rollback",
    (calls) => ({
      // Rule drift after up fails admission; after down every bridge-bound operation fails.
      verifyNetworks: () => {
        throw new Error(down ? "Competition bridge is missing." : "Synthetic changed rule order");
      },
      update: () => {
        if (down) throw new Error("Competition bridge is missing.");
      },
      resetStopped: () => {
        throw new Error("Competition bridge is missing or belongs to another runtime.");
      },
      // The first removal directly follows the rollback's successful Compose down.
      remove: () => {
        down = true;
        removals++;
        calls.push("remove");
        if (removals === 1) throw new Error("Synthetic transient firewall failure");
      },
    }),
    async ({ engine, job, data, calls, retain }) => {
      engine.bindNetworkState({
        jobs: () => [job],
        retain: (updates) => {
          for (const update of updates) Object.assign(job, update);
        },
      });
      await expect(engine.start(job, retain)).rejects.toThrow(
        "Synthetic transient firewall failure",
      );
      expect(job.unit).not.toBeNull();
      job.status = "FAILED";
      await engine.stop(job);
      expect(removals).toBe(2);
      expect(calls.filter((call) => call.startsWith("compose-"))).toEqual([
        "compose-up",
        "compose-down",
      ]);
      expect(calls).not.toContain("stop-owned");
      expect(existsSync(join(data, "runtimes", job.jobId))).toBe(false);
    },
  );
});

test("another team's start finishes while an isolated start waits for its guard install", async () => {
  const alphaInstall = Promise.withResolvers<undefined>();
  await withStart(
    "alpha",
    (calls) => ({
      installAsync: async (plan) => {
        calls.push(`install-${plan.project}`);
        if (plan.project === "tch-alpha") await alphaInstall.promise;
      },
      verifyNetworks: (plan) => {
        throw new Error(`Synthetic drift in ${plan.project}`);
      },
    }),
    async ({ engine, job, calls, retain }) => {
      const alpha = engine.start(job, retain);
      const beta: Job = { ...job, jobId: "beta", teamId: "beta", unit: null };
      await expect(
        engine.start(beta, (unit) => {
          beta.unit = unit;
        }),
      ).rejects.toThrow("Synthetic drift in tch-beta");
      expect(calls).toContain("install-tch-alpha");
      expect(calls.filter((call) => call.startsWith("compose-"))).toEqual([
        "compose-up",
        "compose-down",
      ]);
      alphaInstall.reject(new Error("Synthetic install timeout"));
      await expect(alpha).rejects.toThrow("Synthetic install timeout");
      expect(job.unit).toBeNull();
      expect(calls.filter((call) => call === "compose-up")).toHaveLength(1);
      expect(calls).not.toContain("install");
    },
  );
});
