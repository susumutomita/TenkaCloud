import { Database } from "bun:sqlite";
import { join } from "node:path";
import { hostBuildDirectory } from "./build";
import { persistentKey, prepareDatabase, privateDirectory } from "./files";
import type { GatewayPortRange } from "./gateway-ports";
import { SurfaceGateways } from "./gateways";
import { type HttpHost, startHttpHost } from "./http";
import type { RuntimeEngine } from "./model";
import { HostingService } from "./service";
import { HostStore } from "./store";

export interface LocalHostSettings {
  readonly dataDirectory: string;
  readonly hostname: string;
  readonly adminPort: number;
  readonly participantPort: number;
  readonly gatewayPorts: GatewayPortRange;
}

export interface RunningLocalHost {
  readonly admin: HttpHost;
  readonly participant: HttpHost;
  readonly masterKey: string;
  readonly databasePath: string;
  /** Close listeners first, then wait for in-flight environment work, then close SQLite. */
  stop(): Promise<void>;
}

/**
 * Compose the hosting service, its two listeners and the exercise gateways over one private
 * data directory. `bun start` passes the Docker engine; the browser rehearsal passes its
 * explicitly test-only exercise adapter. Everything else is the same production wiring.
 */
export async function startLocalHost(
  repositoryRoot: string,
  settings: LocalHostSettings,
  createEngine: (dataDirectory: string) => RuntimeEngine,
  announce: (message: string) => void = console.log,
): Promise<RunningLocalHost> {
  const directory = privateDirectory(settings.dataDirectory);
  const databasePath = join(directory, "hosting.sqlite");
  prepareDatabase(databasePath);
  const store = new HostStore(new Database(databasePath, { create: true, strict: true }));
  let admin: HttpHost | undefined;
  let participant: HttpHost | undefined;
  let gateways: SurfaceGateways | undefined;
  let service: HostingService | undefined;
  async function stop(): Promise<void> {
    // Stop accepting requests first: a deployment or teardown accepted after the drain
    // snapshot would otherwise keep writing SQLite/Docker state past store.close().
    await Promise.all([admin?.close(), participant?.close()]);
    admin = undefined;
    participant = undefined;
    await service?.drain();
    await gateways?.close();
    store.close();
  }
  try {
    const masterKey = persistentKey(join(directory, "host-key"));
    const engine = createEngine(directory);
    service = new HostingService(store, engine, masterKey);
    service.gatewayPorts = settings.gatewayPorts;
    service.gatewayHostname = settings.hostname;
    service.assertGatewayRange(settings.gatewayPorts);
    await service.recover();
    const surfaces = new SurfaceGateways(
      settings.hostname,
      service,
      settings.gatewayPorts,
      announce,
    );
    gateways = surfaces;
    service.surfaceLink = (job, team) => surfaces.link(job, team);
    service.closeSurface = (jobId) => surfaces.closeJob(jobId);
    participant = await startHttpHost({
      kind: "participant",
      hostname: settings.hostname,
      port: settings.participantPort,
      staticRoot: hostBuildDirectory(repositoryRoot, "participant-portal"),
      service,
    });
    admin = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: settings.adminPort,
      staticRoot: hostBuildDirectory(repositoryRoot, "application-admin-console"),
      service,
      participantOrigin: participant.origin,
    });
    return { admin, participant, masterKey, databasePath, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
