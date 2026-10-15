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
test("an isolated start whose secret preparation fails retains no ownership, reservation or guard", async () => {
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
      jobId: "secret-rollback",
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
    // A directory where the master secret file belongs makes secret preparation fail.
    mkdirSync(join(data, "runtimes", job.jobId, "problem-secrets.key"), {
      recursive: true,
      mode: 0o700,
    });
    const retained: (string | null)[] = [];
    await expect(
      engine.start(job, (unit) => {
        retained.push(unit);
        job.unit = unit;
      }),
    ).rejects.toThrow("EISDIR");
    expect(retained.map((unit) => (unit === null ? "released" : "owned"))).toEqual([
      "owned",
      "released",
    ]);
    expect(job.unit).toBeNull();
    expect((Reflect.get(engine, "networkReservations") as Map<string, unknown>).size).toBe(0);
    expect(calls).not.toContain("install");
    expect(calls).not.toContain("compose-up");
    expect(existsSync(join(data, "runtimes", job.jobId, "tch-secret-rollback.compose.yml"))).toBe(
      false,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldCli === undefined) delete process.env.TENKACLOUD_COMPOSE_CLI;
    else process.env.TENKACLOUD_COMPOSE_CLI = oldCli;
    rmSync(data, { recursive: true, force: true });
  }
});
