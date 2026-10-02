import { Database } from "bun:sqlite";
import { join } from "node:path";
import { hostBuildDirectory } from "./build";
import { type ContainerLimits, DEFAULT_CONTAINER_LIMITS } from "./container-budget";
import { hasDatabaseState, persistentKey, prepareDatabase, privateDirectory } from "./files";
import type { GatewayPortRange } from "./gateway-ports";
import { SurfaceGateways } from "./gateways";
import { type HttpHost, startHttpHost } from "./http";
import type { AccountConnection, RuntimeEngine } from "./model";
import type { PublicExposure } from "./options";
import { HostingService } from "./service";
import { HostStore } from "./store";

export interface LocalHostSettings {
  readonly dataDirectory: string;
  readonly hostname: string;
  readonly adminPort: number;
  readonly participantPort: number;
  readonly gatewayPorts: GatewayPortRange;
  readonly public?: PublicExposure;
  readonly accountConnection?: AccountConnection;
  readonly containerLimits?: ContainerLimits;
}

export interface RunningLocalHost {
  readonly admin: HttpHost;
  readonly participant: HttpHost;
  readonly masterKey: string;
  readonly masterKeyPath: string;
  readonly databasePath: string;
  /** Returned only on first enablement; never saved or sent to the announcement logger. */
  readonly organizerKey?: string;
  /** Revoke organizer sessions without stopping participant environments or changing their keys. */
  rotateOrganizerKey(): string;
  /** Close listeners, wait for in-flight environment work, write held Battle state, close SQLite. */
  stop(options?: { stopLocalEnvironments?: boolean }): Promise<void>;
}

/**
 * Compose the hosting service, its two listeners and the exercise gateways over one private
 * data directory. `bun start` passes the Docker engine; the browser rehearsal passes its
 * explicitly test-only exercise adapter. Everything else is the same production wiring.
 */
export async function startLocalHost(
  repositoryRoot: string,
  settings: LocalHostSettings,
  createEngine: (dataDirectory: string, store: HostStore) => RuntimeEngine,
  announce: (message: string) => void = console.log,
): Promise<RunningLocalHost> {
  const directory = privateDirectory(settings.dataDirectory);
  const databasePath = join(directory, "hosting.sqlite");
  const masterKeyPath = join(directory, "host-key");
  const masterKey = persistentKey(masterKeyPath, !hasDatabaseState(databasePath));
  prepareDatabase(databasePath);
  const store = new HostStore(new Database(databasePath, { create: true, strict: true }));
  let admin: HttpHost | undefined;
  let participant: HttpHost | undefined;
  let gateways: SurfaceGateways | undefined;
  let service: HostingService | undefined;
  let uptimeTimer: ReturnType<typeof setInterval> | undefined;
  let uptimeTick: Promise<void> | undefined;
  let disruptionTimer: ReturnType<typeof setInterval> | undefined;
  let disruptionTick: Promise<void> | undefined;
  async function stop(options: { stopLocalEnvironments?: boolean } = {}): Promise<void> {
    let unstoppedLocal = 0;
    if (uptimeTimer) clearInterval(uptimeTimer);
    uptimeTimer = undefined;
    if (disruptionTimer) clearInterval(disruptionTimer);
    disruptionTimer = undefined;
    // Stop accepting requests first: a deployment or teardown accepted after the drain
    // snapshot would otherwise keep writing SQLite/Docker state past store.close().
    await Promise.all([admin?.close(), participant?.close()]);
    await disruptionTick;
    admin = undefined;
    participant = undefined;
    await uptimeTick;
    await service?.drain();
    if (options.stopLocalEnvironments && service) {
      const result = await service.stopLocalEnvironments();
      unstoppedLocal = result.failed;
      announce(
        `Stopped ${String(result.stopped)} owned Docker environments; their data is retained.`,
      );
      if (result.cloud > 0)
        announce(
          `${String(result.cloud)} AWS environments remain deployed; local down does not remove cloud resources.`,
        );
    }
    await gateways?.close();
    service?.flush();
    store.close();
    if (unstoppedLocal > 0)
      throw new Error(
        `${String(unstoppedLocal)} local environments could not be stopped; ownership and data are retained.`,
      );
  }
  try {
    const { key: organizerKey } = store.ensureLocalOrganizerKey();
    const engine = createEngine(directory, store);
    service = new HostingService(store, engine, masterKey);
    service.accountConnection = settings.accountConnection;
    service.gatewayPorts = settings.gatewayPorts;
    service.containerLimits = settings.containerLimits ?? DEFAULT_CONTAINER_LIMITS;
    service.listenerPorts = [settings.adminPort, settings.participantPort];
    // Public mode offers no gateway problems; a recovered one must still not open on every interface.
    const gatewayHostname = settings.public ? "127.0.0.1" : settings.hostname;
    service.gatewayHostname = gatewayHostname;
    service.assertGatewayRange(settings.gatewayPorts);
    await service.recover();
    const runningService = service;
    disruptionTimer = setInterval(() => {
      if (disruptionTick) return;
      disruptionTick = runningService.disruptions
        .tick()
        .catch(() =>
          announce(
            "Disruption processing failed; inspect durable execution history before retrying.",
          ),
        )
        .finally(() => {
          disruptionTick = undefined;
        });
    }, 1000);
    const surfaces = new SurfaceGateways(gatewayHostname, service, settings.gatewayPorts, announce);
    gateways = surfaces;
    service.surfaceLink = (job, team, path) => surfaces.link(job, team, path);
    service.closeSurface = (jobId) => surfaces.closeJob(jobId);
    participant = await startHttpHost({
      kind: "participant",
      hostname: settings.hostname,
      port: settings.participantPort,
      advertised: settings.public?.participantOrigin,
      behindProxy: settings.public?.behindProxy,
      staticRoot: hostBuildDirectory(repositoryRoot, "participant-portal"),
      service,
    });
    admin = await startHttpHost({
      kind: "admin",
      hostname: settings.public ? "0.0.0.0" : "127.0.0.1",
      port: settings.adminPort,
      advertised: settings.public?.adminOrigin,
      behindProxy: settings.public?.behindProxy,
      staticRoot: hostBuildDirectory(repositoryRoot, "application-admin-console"),
      service,
      participantOrigin: participant.origin,
    });
    const pollUptime = () => {
      if (!service || uptimeTick) return;
      uptimeTick = service.uptime
        .tick()
        .catch((error: unknown) => {
          announce(
            `Uptime scheduler failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          uptimeTick = undefined;
        });
    };
    uptimeTimer = setInterval(pollUptime, 10_000);
    pollUptime();
    return {
      admin,
      participant,
      masterKey,
      masterKeyPath,
      databasePath,
      organizerKey,
      rotateOrganizerKey: () => store.rotateLocalOrganizerKey(),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
