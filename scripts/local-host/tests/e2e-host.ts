/**
 * Browser-rehearsal host: the production `startLocalHost` wiring (listeners, SQLite, gateways,
 * built interfaces) over a temporary data directory. `HOST_E2E_ENGINE=docker` uses the real
 * Docker engine; the default is the explicitly test-only exercise adapter, and the harness
 * reports which one ran. Prints public URLs only; the organizer key uses a private parent pipe.
 */
import { Database } from "bun:sqlite";
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerHostingEngine } from "../docker-engine";
import { parseGatewayPorts } from "../gateway-ports";
import { type RunningLocalHost, startLocalHost } from "../server";
import { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { ExerciseFixture } from "./exercise-fixture";

export async function cleanOwnedDockerJobs(
  root: string,
  data: string,
  engine: Pick<DockerHostingEngine, "stop"> = new DockerHostingEngine(root, data),
): Promise<boolean> {
  const databasePath = join(data, "hosting.sqlite");
  if (!existsSync(databasePath)) throw new Error(`Fixture database is missing: ${databasePath}`);
  const database = new Database(databasePath, { strict: true });
  let store: HostStore | undefined;
  let clean = true;
  try {
    store = new HostStore(database);
    // This fixture creates a fresh database. Every persisted unit belongs to this run.
    for (const job of store.jobs()) {
      if (!job.unit) continue;
      try {
        await engine.stop(job);
        job.unit = null;
        job.status = "DELETED";
        store.putJob(job);
      } catch (error) {
        clean = false;
        console.error(`Fixture Docker cleanup failed for job ${job.jobId}:`, error);
      }
    }
  } finally {
    if (store) store.close();
    else database.close();
  }
  return clean;
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const engineKind = process.env.HOST_E2E_ENGINE === "docker" ? "docker" : "fixture";
  const data = createTemporaryDirectory(root, "tenkacloud-host-e2e-");
  const fixture = new ExerciseFixture((path) => new Database(path, { strict: true }));
  let host: RunningLocalHost | undefined;
  let requestStop: () => void = () => undefined;
  const stopped = new Promise<void>((accept) => {
    requestStop = accept;
  });
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);
  try {
    host = await startLocalHost(
      root,
      {
        dataDirectory: data,
        hostname: "127.0.0.1",
        adminPort: Number(process.env.HOST_E2E_ADMIN_PORT ?? 5184),
        participantPort: Number(process.env.HOST_E2E_PARTICIPANT_PORT ?? 5185),
        gatewayPorts: parseGatewayPorts(process.env.HOST_E2E_GATEWAY_PORTS ?? "5300-5339"),
      },
      (directory) => (engineKind === "docker" ? new DockerHostingEngine(root, directory) : fixture),
      (message) => console.error(message),
    );
    if (!host.organizerKey) throw new Error("The fresh browser fixture has no organizer key.");
    if (process.env.HOST_E2E_KEY_FD !== "3")
      throw new Error("Browser fixture requires its private organizer-key pipe.");
    writeSync(3, `${host.organizerKey}\n`);
    console.log(
      JSON.stringify({
        admin: host.admin.origin,
        participant: host.participant.origin,
        engine: engineKind,
      }),
    );
    await stopped;
  } finally {
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    try {
      await host?.stop();
      if (
        engineKind === "docker" &&
        existsSync(join(data, "hosting.sqlite")) &&
        !(await cleanOwnedDockerJobs(root, data))
      ) {
        console.error(`Fixture SQLite ownership retained at ${join(data, "hosting.sqlite")}.`);
        process.exitCode = 1;
      } else {
        if (engineKind === "fixture") await fixture.close();
        removeTemporaryDirectory(root, data);
      }
    } catch (error) {
      console.error(`Fixture cleanup failed; inspect retained data at ${data}:`, error);
      process.exitCode = 1;
    }
  }
}
if (import.meta.main)
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
