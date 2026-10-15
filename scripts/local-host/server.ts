import { join } from "node:path";
import { hostBuildDirectory } from "./build";
import type { ConsoleAppliance } from "./console-appliance";
import { type ContainerLimits, DEFAULT_CONTAINER_LIMITS } from "./container-budget";
import { hasDatabaseState, persistentKey, prepareDatabase, privateDirectory } from "./files";
import { type GatewayPortRange, gatewayOffset, gatewayPort } from "./gateway-ports";
import { SurfaceGateways } from "./gateways";
import { type HttpHost, startHttpHost } from "./http";
import { openLocalDatabase } from "./local-database";
import { localJobDescription, localRuntimeFailure } from "./local-runtime-report";
import type { AccountConnection, RuntimeEngine, SqlDatabase } from "./model";
import type { PublicExposure } from "./options";
import type { OrganizerPasswords } from "./organizer-passwords";
import { PublishedWebBroker } from "./published-web-broker";
import { HostingService } from "./service";
import { digest, HostStore } from "./store";

export interface LocalHostSettings {
  readonly dataDirectory: string;
  readonly hostname: string;
  readonly adminPort: number;
  readonly participantPort: number;
  readonly gatewayPorts: GatewayPortRange;
  readonly public?: PublicExposure;
  readonly consoleAppliance?: ConsoleAppliance;
  readonly vpn?: import("./vpn/native-backend").VpnIngress;
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

function assertVpnSettings(settings: LocalHostSettings): void {
  const vpn = settings.vpn;
  if (!vpn) return;
  if (
    settings.public ||
    settings.hostname !== vpn.plan.serverIpv4 ||
    settings.participantPort !== vpn.plan.participantPort
  )
    throw new Error(
      "VPN requires its dedicated participant address/port and loopback administration.",
    );
  vpn.seal();
}
async function collectVpnCleanupFailure(
  failures: unknown[],
  work: () => void | Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    failures.push(error);
  }
}
function vpnHttpAuthorization(settings: LocalHostSettings, store: HostStore) {
  const vpn = settings.vpn;
  return vpn
    ? {
        authorizePeer: (remote: string, token: string) =>
          vpn.authorize(remote, store.authenticateTeam(token)),
        authorizeTerminalPeer: (remote: string, grant: import("./host-terminal").TerminalGrant) =>
          vpn.authorize(remote, grant),
      }
    : {};
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
  providers: {
    openDatabase?: (path: string) => Promise<SqlDatabase>;
    passwords?: OrganizerPasswords;
  } = {},
): Promise<RunningLocalHost> {
  assertVpnSettings(settings);
  assertConsoleSettings(settings);
  const directory = privateDirectory(settings.dataDirectory);
  const databasePath = join(directory, "hosting.sqlite");
  const masterKeyPath = join(directory, "host-key");
  const masterKey = persistentKey(masterKeyPath, !hasDatabaseState(databasePath));
  prepareDatabase(databasePath);
  const database = await (providers.openDatabase ?? openLocalDatabase)(databasePath);
  let store: HostStore;
  try {
    store = new HostStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
  let admin: HttpHost | undefined;
  let participant: HttpHost | undefined;
  let gateways: SurfaceGateways | undefined;
  let webBroker: PublishedWebBroker | undefined;
  let service: HostingService | undefined;
  let transportEngine: RuntimeEngine | undefined;
  let uptimeTimer: ReturnType<typeof setInterval> | undefined;
  let uptimeTick: Promise<void> | undefined;
  let disruptionTimer: ReturnType<typeof setInterval> | undefined;
  let disruptionTick: Promise<void> | undefined;
  let networkTimer: ReturnType<typeof setInterval> | undefined;
  let networkTick: Promise<void> | undefined;
  async function stopOwnedEnvironments(unstoppedLocal: string[]): Promise<void> {
    if (!service) return;
    const result = await service.stopLocalEnvironments((job) => {
      unstoppedLocal.push(
        `${localJobDescription(job)} status=${job.status}: ${localRuntimeFailure(job.error)}`,
      );
    });
    announce(
      `Stopped ${String(result.stopped)} owned Docker environments; their data is retained.`,
    );
    if (result.cloud > 0)
      announce(
        `${String(result.cloud)} AWS environments remain deployed; local down does not remove cloud resources.`,
      );
  }
  async function stop(options: { stopLocalEnvironments?: boolean } = {}): Promise<void> {
    const vpnStopFailures: unknown[] = [];
    await collectVpnCleanupFailure(vpnStopFailures, () => settings.vpn?.seal());
    const unstoppedLocal: string[] = [];
    if (networkTimer) clearInterval(networkTimer);
    networkTimer = undefined;
    if (uptimeTimer) clearInterval(uptimeTimer);
    uptimeTimer = undefined;
    if (disruptionTimer) clearInterval(disruptionTimer);
    disruptionTimer = undefined;
    // Stop accepting requests first: a deployment or teardown accepted after the drain
    // snapshot would otherwise keep writing SQLite/Docker state past store.close().
    await Promise.all([admin?.close(), participant?.close()]);
    await disruptionTick;
    await networkTick;
    admin = undefined;
    participant = undefined;
    await uptimeTick;
    await service?.drain();
    if (options.stopLocalEnvironments) await stopOwnedEnvironments(unstoppedLocal);
    await gateways?.close();
    await webBroker?.close();
    await collectVpnCleanupFailure(vpnStopFailures, () => transportEngine?.closeTransports?.());
    service?.flush();
    store.close();
    if (unstoppedLocal.length > 0)
      throw new Error(
        `${String(unstoppedLocal.length)} owned Docker jobs are not confirmed stopped (including earlier failed deployments, not a container count); ownership and data are retained.\n${unstoppedLocal.join("\n")}`,
      );
    if (vpnStopFailures.length)
      throw new AggregateError(
        vpnStopFailures,
        "VPN closure failed; remaining cleanup was attempted.",
      );
  }
  try {
    const { key: organizerKey } = store.ensureLocalOrganizerKey();
    const engine = createEngine(directory, store);
    transportEngine = engine;
    if (settings.vpn) {
      if (!engine.bindVpnIngress) throw new Error("Runtime has no fail-closed VPN lifecycle.");
      engine.bindVpnIngress(settings.vpn, (job) =>
        gatewayPort(settings.gatewayPorts, gatewayOffset(job)),
      );
    }
    service = new HostingService(
      store,
      engine,
      masterKey,
      undefined,
      undefined,
      undefined,
      providers.passwords,
    );
    service.accountConnection = settings.accountConnection;
    service.gatewayPorts = settings.gatewayPorts;
    service.containerLimits = settings.containerLimits ?? DEFAULT_CONTAINER_LIMITS;
    service.listenerPorts = listenerPorts(settings);
    // Public mode offers no gateway problems; a recovered one must still not open on every interface.
    const gatewayHostname = settings.public ? "127.0.0.1" : settings.hostname;
    service.gatewayHostname = gatewayHostname;
    service.assertGatewayRange(settings.gatewayPorts);
    await service.recover();
    if (settings.vpn) await engine.auditNetworks?.();
    const runningService = service;
    if (engine.auditNetworks)
      networkTimer = setInterval(() => {
        if (networkTick) return;
        networkTick = engine
          .auditNetworks?.()
          .catch(() =>
            announce("Competition network auditing failed; verify retained workload shutdown."),
          )
          .finally(() => {
            networkTick = undefined;
          });
      }, 10_000);
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
    const surfaces = new SurfaceGateways(
      gatewayHostname,
      service,
      settings.gatewayPorts,
      announce,
      settings.vpn ? (remote, job) => settings.vpn?.authorize(remote, job) : undefined,
    );
    gateways = surfaces;
    service.closeSurface = (jobId) => surfaces.closeJob(jobId);
    webBroker = await configureSurfaceAccess(settings, service, surfaces);
    participant = await startHttpHost({
      kind: "participant",
      hostname: settings.hostname,
      port: settings.participantPort,
      advertised: settings.consoleAppliance?.consoleOrigin ?? settings.public?.participantOrigin,
      behindProxy: settings.consoleAppliance?.behindProxy ?? settings.public?.behindProxy,
      staticRoot: hostBuildDirectory(repositoryRoot, "participant-portal"),
      service,
      ...vpnHttpAuthorization(settings, store),
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
    service.listenerPorts = listenerPorts(settings, admin.boundPort, participant.boundPort);
    service.assertGatewayRange(settings.gatewayPorts);
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

function assertConsoleSettings(settings: LocalHostSettings): void {
  if (
    settings.consoleAppliance &&
    (settings.public || settings.vpn || settings.hostname !== "127.0.0.1")
  )
    throw new Error("Console appliance listeners require loopback native hosting.");
}
function listenerPorts(
  settings: LocalHostSettings,
  admin = settings.adminPort,
  participant = settings.participantPort,
): number[] {
  return [
    admin,
    participant,
    ...(settings.consoleAppliance ? [settings.consoleAppliance.webPort] : []),
  ].filter((port) => port !== 0);
}
async function configureSurfaceAccess(
  settings: LocalHostSettings,
  service: HostingService,
  surfaces: SurfaceGateways,
) {
  if (!settings.consoleAppliance) {
    service.surfaceLink = (job, team, path) => surfaces.link(job, team, path);
    return undefined;
  }
  const broker = new PublishedWebBroker(service, settings.consoleAppliance);
  await broker.listen();
  service.publicWebServices = settings.consoleAppliance.webServiceIds;
  service.publicWebRevoke = (teamId) => broker.revokeTeam(teamId);
  service.publicWebHandoff = (team, problemId, target) =>
    broker.issue(team.teamId, digest(team.loginKey), problemId, target);
  return broker;
}
