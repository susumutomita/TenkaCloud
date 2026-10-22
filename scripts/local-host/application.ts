import { fileURLToPath } from "node:url";
import { assertHostCatalogBuild, buildHosting } from "./build";
import { CompetitionEngine } from "./competition-engine";
import { dockerAvailability } from "./container/compose-cli";
import { DEFAULT_GATEWAY_PORTS, formatGatewayPorts } from "./gateway-ports";
import { parseOptions, vpnListener } from "./options";
import { openOrganizerKeyDisplay } from "./organizer-key-output";
import { type RunningLocalHost, startLocalHost } from "./server";
import { loadVpnPeerPlan } from "./vpn/config";
import { NativeVpnIngress } from "./vpn/native-ingress";

function waitForStop(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((accept) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      signal?.removeEventListener("abort", stop);
      accept();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

export function announceHost(
  options: ReturnType<typeof parseOptions>,
  host: {
    readonly admin: { readonly origin: string };
    readonly participant: { readonly origin: string };
    readonly databasePath: string;
  },
  stopLocalEnvironments: boolean,
): void {
  if (options.consoleAppliance) {
    console.log(
      `\nHost console: ${host.admin.origin}\nParticipant portal: ${host.participant.origin}\nWeb broker upstream: http://127.0.0.1:${options.consoleAppliance.webPort}\nState: ${host.databasePath}\n`,
    );
  } else if (options.public) {
    console.log(
      `\nHost console: ${host.admin.origin}\nHost API: ${host.admin.origin}/api-docs\nParticipant API: ${host.participant.origin}/api-docs\nParticipant portal: ${host.participant.origin}\nOrganizer key: run make local-reset in a private interactive terminal to obtain a key; existing organizer sessions are revoked.\nState: ${host.databasePath}\nDocker Compose problems are not offered in public mode.\n`,
    );
  } else {
    const gateways = `http://${options.hostname}:${formatGatewayPorts(options.gatewayPorts)}`;
    console.log(
      `\nHost console: ${host.admin.origin}\nHost API: ${host.admin.origin}/api-docs\nParticipant API: ${host.participant.origin}/api-docs\nParticipant portal: ${host.participant.origin}\nExercise gateways: ${gateways} (active local environments only)\nOrganizer key: each interactive make local start shows a new key. Use make local-reset to rotate it while running.\nState: ${host.databasePath}\n`,
    );
  }
  if (
    !options.public &&
    !options.consoleAppliance &&
    !options.vpnPeerPath &&
    options.hostname !== "127.0.0.1"
  )
    console.warn(
      `WARNING: LAN HTTP is unencrypted. Use a trusted isolated network only. Never port-forward these listeners to the Internet.\nAllow TCP ${String(options.participantPort)} and ${formatGatewayPorts(options.gatewayPorts)} on ${options.hostname} in the firewall; keep ${String(options.adminPort)} closed.`,
    );
  if (options.unsafeDockerLan)
    console.warn(
      "WARNING: --unsafe-docker-lan gives Docker exercises no network isolation. Each team's exercises can reach other teams' exercises, this host and the LAN. Use it only with participants you trust.",
    );
  console.log(
    stopLocalEnvironments
      ? "Create an event, prepare its environments, distribute team keys, then start the event. Participants start/resume local problems as needed.\nCtrl+C or make down stops owned local environments and retains their data. Use Teardown to delete environments."
      : "Create an event, prepare its environments, distribute team keys, then start the event. Participants start/resume local problems as needed.\nCtrl+C stops the host server but preserves results and Docker environments. Use Teardown in the host console to remove environments.",
  );
}

function displayLocalOrganizerKey(host: RunningLocalHost): void {
  let display: ReturnType<typeof openOrganizerKeyDisplay>;
  try {
    // Acquire the private terminal before rotating an existing key. Headless
    // startup retains its current key and never sends secrets to captured logs.
    display = openOrganizerKeyDisplay();
  } catch {
    console.log(
      `Organizer key ${host.organizerKey ? "initialized" : "retained"}. Run make local-reset in an interactive terminal to obtain a new key; secrets are not shown in logs.`,
    );
    return;
  }
  try {
    display.show(host.organizerKey ?? host.rotateOrganizerKey());
  } finally {
    display.close();
  }
}

/** Listener exposure requires isolation unless --unsafe-docker-lan opts out; never enables native firewall changes. */
export function localCompetitionEngine(
  root: string,
  directory: string,
  options: ReturnType<typeof parseOptions>,
  docker: ReturnType<typeof dockerAvailability> = { available: true },
): CompetitionEngine {
  const engine = new CompetitionEngine(
    root,
    directory,
    !options.public && docker.available,
    undefined,
    options.dockerNetworkPool,
    options.submissionCatalogPath,
    options.competitionNetwork,
    docker.reason ? [docker.reason] : [],
  );
  if (options.public || options.hostname === "127.0.0.1") return engine;
  const isolated = engine.requireNetworkIsolation();
  return options.unsafeDockerLan ? isolated.allowUnisolatedDockerLan() : isolated;
}

export async function runLocalHost(
  args: string[],
  lifecycle: {
    repositoryRoot?: string;
    signal?: AbortSignal;
    stopLocalEnvironments?: boolean;
    onReady?: (host: RunningLocalHost) => void;
  } = {},
): Promise<void> {
  const root = lifecycle.repositoryRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  const options = parseOptions(args, root);
  if (options.help) {
    console.log(
      `TenkaCloud local competition hosting\n\nmake local LOCAL_ARGS="[--data <directory>] [--no-build]"\n  --submission-catalog <file>  Organizer-owned fixed-edition answer / self-report catalog\n  --admin-port 5174       Host console; loopback unless using public origins\n  --participant-port 5175 Participant portal\n  --gateway-ports ${DEFAULT_GATEWAY_PORTS}  Exercise gateways, leased only by active local environments\n  --max-active-per-team 3  Per-team local environment limit\n  --max-active-environments 12  Host-wide active environment limit\n  --container-memory-mib 4096  Sum of container memory caps, not a hardware benchmark\n  --docker-network-pool <CIDR>  Explicit private /16–/24 pool for compact project networks; must not overlap LAN/VPN routes\n  --competition-network  Fail-closed native Linux 28.4.x team isolation (requires pool, root firewall/nsenter access)\n  --console-origin https://play.example --web-origin-template https://{target}.labs.example  Native console-only appliance behind an operator-managed TLS proxy\n  --web-port 5176 --web-services web  Loopback Web broker and declared HTTP service IDs\n  --vpn-peers <root-owned-json>  Preconfigured dedicated Linux WireGuard ingress (requires boot seal service)\n  --lan <private-ip> --unsafe-lan  Explicit unencrypted hosting; Docker exercises require native isolation unless --unsafe-docker-lan is given\n  --unsafe-docker-lan     With --lan --unsafe-lan only: run Docker exercises with no team network isolation, for trusted participants (new events only)\n  --public-admin-origin https://… --public-participant-origin https://…  Behind a TLS-terminating proxy that passes the original Host header\n  --behind-proxy          Rate-limit by the proxy-appended X-Forwarded-For entry\n\nCodespaces automatically selects exact HTTPS forwarding origins for native public mode; keep organizer port 5174 Private. Port visibility is never changed.\nThe local host uses Bun, or the Node 24 development entry with built interfaces and SQLite. The local Challenge catalog requires Docker Compose. AWS service problems are available only with cloud hosting.\nmake local opens the unified competition console. make down stops local environments while retaining their data.`,
    );
    return;
  }
  if (process.platform === "win32")
    throw new Error("Native Windows is not supported; use WSL2 or a macOS/Linux host.");
  process.umask(0o077);
  if (lifecycle.signal?.aborted) return;
  if (options.build) await buildHosting(root, "summary");
  else assertHostCatalogBuild(root);
  if (lifecycle.signal?.aborted) return;
  console.log("Starting the host server...");
  const vpn = options.vpnPeerPath
    ? new NativeVpnIngress(loadVpnPeerPlan(options.vpnPeerPath))
    : undefined;
  const settings = { ...options, ...(vpn ? { ...vpnListener(options, vpn.plan), vpn } : {}) };
  const docker = options.public ? { available: false } : dockerAvailability();
  if ("reason" in docker && docker.reason) console.warn(docker.reason);
  const host = await startLocalHost(root, settings, (directory) =>
    localCompetitionEngine(root, directory, options, docker),
  );
  try {
    lifecycle.onReady?.(host);
    // A container's controlling TTY can be captured by its log driver. Public hosts
    // recover keys only through a separate private exec terminal, never startup output.
    if (!options.public) displayLocalOrganizerKey(host);
    announceHost(settings, host, lifecycle.stopLocalEnvironments === true);
    await waitForStop(lifecycle.signal);
    console.log("Closing listeners; waiting for in-flight environment operations to finish.");
  } finally {
    await host.stop({ stopLocalEnvironments: lifecycle.stopLocalEnvironments });
  }
}
