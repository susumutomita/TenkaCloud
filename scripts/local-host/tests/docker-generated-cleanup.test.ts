import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DockerDefinition, loadDockerCatalog } from "../docker-catalog";
import { DockerHostingEngine } from "../docker-engine";
import type { Job } from "../model";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

async function fixture(
  run: (f: {
    engine: DockerHostingEngine;
    job: Job;
    data: string;
    directory: string;
    compose: string;
    seed: string;
    failUp: string;
    failDown: string;
  }) => Promise<void>,
) {
  const data = mkdtempSync(join(tmpdir(), "tenka-docker-cleanup-synthetic-"));
  const bin = join(data, "bin");
  mkdirSync(bin);
  const failUp = join(data, "fail-up");
  const failDown = join(data, "fail-down");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
case " $* " in
  *" up "*) if [ -f ${JSON.stringify(failUp)} ]; then exit 1; fi ;;
  *" down "*) if [ -f ${JSON.stringify(failDown)} ]; then exit 1; fi ;;
esac
exit 0
`,
    { mode: 0o700 },
  );
  const oldPath = process.env.PATH;
  const oldCli = process.env.TENKACLOUD_COMPOSE_CLI;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.TENKACLOUD_COMPOSE_CLI = "docker compose";
  const verifier = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("synthetic"),
  });
  try {
    const selected = loadDockerCatalog(repository)[0];
    if (!selected) throw new Error("Missing catalog fixture.");
    const definition = JSON.parse(selected.definition) as DockerDefinition;
    const origin = `http://127.0.0.1:${String(verifier.port)}`;
    const job: Job = {
      jobId: "synthetic-job",
      eventId: "synthetic-event",
      teamId: "synthetic-team",
      problemId: selected.problemId,
      definition: JSON.stringify({
        ...definition,
        problem: {
          ...definition.problem,
          verifyUrl: `${origin}/verify`,
          challengeEndpoints: { web: origin },
        },
      }),
      offset: 0,
      status: "PENDING",
      unit: null,
    };
    const directory = join(data, "runtimes", job.jobId);
    await run({
      engine: new DockerHostingEngine(repository, data),
      job,
      data,
      directory,
      compose: join(directory, "tch-synthetic-job.compose.yml"),
      seed: join(directory, "problem-secrets.key"),
      failUp,
      failDown,
    });
  } finally {
    await verifier.stop(true);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldCli === undefined) delete process.env.TENKACLOUD_COMPOSE_CLI;
    else process.env.TENKACLOUD_COMPOSE_CLI = oldCli;
    rmSync(data, { recursive: true, force: true });
  }
}

test("pause/resume and failed teardown retain seeds; confirmed teardown removes generated files", async () => {
  await fixture(async (f) => {
    await f.engine.start(f.job, (unit) => {
      f.job.unit = unit;
    });
    const seed = readFileSync(f.seed, "utf8");
    const composition = readFileSync(f.compose, "utf8");
    await f.engine.pause(f.job);
    expect(readFileSync(f.seed, "utf8")).toBe(seed);
    expect(readFileSync(f.compose, "utf8")).toBe(composition);
    await f.engine.resume(f.job);
    expect(readFileSync(f.seed, "utf8")).toBe(seed);
    writeFileSync(f.failDown, "synthetic failure");
    await expect(f.engine.stop(f.job)).rejects.toThrow("Compose down failed");
    expect(readFileSync(f.seed, "utf8")).toBe(seed);
    expect(readFileSync(f.compose, "utf8")).toBe(composition);
    rmSync(f.failDown);
    await f.engine.stop(f.job);
    expect(existsSync(f.directory)).toBe(false);
    // A crash before SQLite releases ownership can retry physical teardown safely.
    await f.engine.stop(f.job);
    expect(existsSync(f.compose)).toBe(false);
    expect(existsSync(f.directory)).toBe(false);
  });
});

for (const cleanupFails of [false, true]) {
  test(`failed startup ${cleanupFails ? "retains retry ownership" : "leaves no generated runtime"}`, async () => {
    await fixture(async (f) => {
      writeFileSync(f.failUp, "synthetic startup failure");
      if (cleanupFails) writeFileSync(f.failDown, "synthetic cleanup failure");
      await expect(
        f.engine.start(f.job, (unit) => {
          f.job.unit = unit;
        }),
      ).rejects.toThrow("Compose up failed");
      expect(Boolean(f.job.unit)).toBe(cleanupFails);
      expect(existsSync(f.seed)).toBe(cleanupFails);
      expect(existsSync(f.compose)).toBe(cleanupFails);
      expect(existsSync(f.directory)).toBe(cleanupFails);
    });
  });
}
