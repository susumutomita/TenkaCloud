/**
 * Browser-rehearsal host: the production `startLocalHost` wiring (listeners, SQLite, gateways,
 * built interfaces) over a temporary data directory. `HOST_E2E_ENGINE=docker` uses the real
 * Docker engine; the default is the explicitly test-only exercise adapter, and the harness
 * reports which one ran. Prints one JSON line with the URLs and host key, then waits for SIGTERM.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerHostingEngine } from "../docker-engine";
import { parseGatewayPorts } from "../gateway-ports";
import { startLocalHost } from "../server";
import { ExerciseFixture } from "./exercise-fixture";

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
  await host.stop();
  if (engineKind === "fixture") await fixture.close();
  rmSync(data, { recursive: true, force: true });
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
