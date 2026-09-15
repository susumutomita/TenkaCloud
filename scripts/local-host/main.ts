import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHosting } from "./build";
import { DockerHostingEngine } from "./docker-engine";
import { persistentKey, prepareDatabase, privateDirectory } from "./files";
import { SurfaceGateways } from "./gateways";
import { startHttpHost, type HttpHost } from "./http";
import { parseOptions } from "./options";
import { HostingService } from "./service";
import { HostStore } from "./store";

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const options = parseOptions(process.argv.slice(2), root);
  if (options.help) {
    console.log("TenkaCloud local competition hosting\n\nbun start [--data <directory>] [--no-build]\n  --admin-port 5174       Host console; always loopback-only\n  --participant-port 5175 Participant portal\n  --lan <private-ip> --unsafe-lan  Explicit unencrypted LAN hosting\n\nThe host application needs Bun and SQLite only. The sqli-demo problem requires Docker Compose.\nExisting make local individual practice is unchanged.");
    return;
  }
  if (process.platform === "win32") throw new Error("Native Windows is not supported; use WSL2 or a macOS/Linux host.");
  process.umask(0o077);
  const directory = privateDirectory(options.dataDirectory);
  const databasePath = join(directory, "hosting.sqlite");
  prepareDatabase(databasePath);
  const store = new HostStore(new Database(databasePath, { create: true, strict: true }));
  let admin: HttpHost | undefined;
  let participant: HttpHost | undefined;
  let gateways: SurfaceGateways | undefined;
  try {
    const masterKey = persistentKey(join(directory, "host-key"));
    const engine = new DockerHostingEngine(root, directory);
    if (options.build) await buildHosting(root);
    const service = new HostingService(store, engine, masterKey);
    await service.recover();
    const surfaces = new SurfaceGateways(options.hostname, service);
    gateways = surfaces;
    service.surfaceLink = (job, team) => surfaces.link(job, team);
    service.closeSurface = jobId => surfaces.closeJob(jobId);
    participant = await startHttpHost({
      kind: "participant",
      hostname: options.hostname,
      port: options.participantPort,
      staticRoot: join(root, ".tenkacloud/host-build/participant-portal"),
      service
    });
    admin = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: options.adminPort,
      staticRoot: join(root, ".tenkacloud/host-build/application-admin-console"),
      service,
      participantOrigin: participant.origin
    });
    console.log(`\nHost console: ${admin.origin}\nParticipant portal: ${participant.origin}\nHost login key: ${masterKey}\nState: ${databasePath}\n`);
    if (options.hostname !== "127.0.0.1") console.warn("WARNING: LAN HTTP is unencrypted. Use a trusted isolated network only. Never port-forward these listeners to the Internet.");
    console.log("Create an event, deploy its problem environments, distribute team keys, then start the event.\nCtrl+C stops the host server but preserves results and Docker environments. Use Teardown in the host console to remove environments.");
    await new Promise<void>(accept => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        accept();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await service.drain();
  } finally {
    await Promise.all([admin?.close(), participant?.close()]);
    await gateways?.close();
    store.close();
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
