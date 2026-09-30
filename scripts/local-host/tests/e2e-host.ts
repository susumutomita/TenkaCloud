/**
 * Browser-rehearsal host: the production `startLocalHost` wiring (listeners, SQLite, gateways,
 * built interfaces) over a temporary data directory. `HOST_E2E_ENGINE=docker` uses the real
 * Docker engine; the default is the explicitly test-only exercise adapter, and the harness
 * reports which one ran. Prints one JSON line with the URLs and host key, then waits for SIGTERM.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerHostingEngine } from "../docker-engine";
import { parseGatewayPorts } from "../gateway-ports";
import { startLocalHost } from "../server";
import { HostStore } from "../store";
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
  const data = mkdtempSync(join(tmpdir(), "tenkacloud-host-e2e-"));
  const fixture = new ExerciseFixture((path) => new Database(path, { strict: true }));
  const host = await startLocalHost(
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
  console.log(
    JSON.stringify({
      admin: host.admin.origin,
      participant: host.participant.origin,
      key: host.masterKey,
      engine: engineKind,
    }),
  );
  await new Promise<void>((accept) => {
    process.once("SIGTERM", accept);
    process.once("SIGINT", accept);
  });
  try {
    await host.stop();
    if (engineKind === "docker" && !(await cleanOwnedDockerJobs(root, data))) {
      console.error(`Fixture SQLite ownership retained at ${join(data, "hosting.sqlite")}.`);
      process.exitCode = 1;
      return;
    }
    if (engineKind === "fixture") await fixture.close();
    rmSync(data, { recursive: true, force: true });
  } catch (error) {
    console.error(`Fixture cleanup failed; inspect retained data at ${data}:`, error);
    process.exitCode = 1;
  }
}
if (import.meta.main)
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
