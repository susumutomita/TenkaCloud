import { fileURLToPath } from "node:url";
import { buildHosting } from "./build";
import { CompetitionEngine } from "./competition-engine";
import { DEFAULT_GATEWAY_PORTS, formatGatewayPorts } from "./gateway-ports";
import { parseOptions } from "./options";
import { openOrganizerKeyDisplay } from "./organizer-key-output";
import { type RunningLocalHost, startLocalHost } from "./server";

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

function announceHost(
  options: ReturnType<typeof parseOptions>,
  host: Awaited<ReturnType<typeof startLocalHost>>,
  stopLocalEnvironments: boolean,
): void {
  if (options.public) {
    console.log(
      `\nHost console: ${host.admin.origin}\nParticipant portal: ${host.participant.origin}\nOrganizer key: use make local-reset to rotate a lost key.\nState: ${host.databasePath}\nDocker Compose problems are not offered in public mode.\n`,
    );
  } else {
    const gateways = `http://${options.hostname}:${formatGatewayPorts(options.gatewayPorts)}`;
    console.log(
      `\nHost console: ${host.admin.origin}\nParticipant portal: ${host.participant.origin}\nExercise gateways: ${gateways} (active local environments only)\nOrganizer key: each interactive make local start shows a new key. Use make local-reset to rotate it while running.\nState: ${host.databasePath}\n`,
    );
  }
  if (!options.public && options.hostname !== "127.0.0.1")
    console.warn(
      `WARNING: LAN HTTP is unencrypted. Use a trusted isolated network only. Never port-forward these listeners to the Internet.\nAllow TCP ${String(options.participantPort)} and ${formatGatewayPorts(options.gatewayPorts)} on ${options.hostname} in the firewall; keep ${String(options.adminPort)} closed.`,
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

export async function runLocalHost(
  args: string[],
  lifecycle: {
    signal?: AbortSignal;
    stopLocalEnvironments?: boolean;
    onReady?: (host: RunningLocalHost) => void;
  } = {},
): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const options = parseOptions(args, root);
  if (options.help) {
    console.log(
      `TenkaCloud local competition hosting\n\nmake local LOCAL_ARGS="[--data <directory>] [--no-build]"\n  --admin-port 5174       Host console; always loopback-only\n  --participant-port 5175 Participant portal\n  --gateway-ports ${DEFAULT_GATEWAY_PORTS}  Exercise gateways, leased only by active local environments\n  --max-active-per-team 3  Per-team local environment limit\n  --max-active-environments 12  Host-wide active environment limit\n  --container-memory-mib 4096  Sum of container memory caps, not a hardware benchmark\n  --docker-network-pool <CIDR>  Explicit private /16–/24 pool for compact project networks; must not overlap LAN/VPN routes\n  --lan <private-ip> --unsafe-lan  Explicit unencrypted LAN hosting\n  --public-admin-origin https://… --public-participant-origin https://…  Behind a TLS-terminating proxy that passes the original Host header\n  --behind-proxy          Rate-limit by the proxy-appended X-Forwarded-For entry\n\nThe host application and Cryptography Battle need Bun and SQLite only. The local Challenge catalog requires Docker Compose. AWS service problems are available only with cloud hosting.\nmake local opens the unified competition console. make down stops local environments while retaining their data.`,
    );
    return;
  }
  if (process.platform === "win32")
    throw new Error("Native Windows is not supported; use WSL2 or a macOS/Linux host.");
  process.umask(0o077);
  if (lifecycle.signal?.aborted) return;
  if (options.build) await buildHosting(root);
  if (lifecycle.signal?.aborted) return;
  const host = await startLocalHost(
    root,
    options,
    (directory) =>
      new CompetitionEngine(root, directory, !options.public, undefined, options.dockerNetworkPool),
  );
  try {
    lifecycle.onReady?.(host);
    // A container's controlling TTY can be captured by its log driver. Public hosts
    // recover keys only through a separate private exec terminal, never startup output.
    if (!options.public) displayLocalOrganizerKey(host);
    announceHost(options, host, lifecycle.stopLocalEnvironments === true);
    await waitForStop(lifecycle.signal);
    console.log("Closing listeners; waiting for in-flight environment operations to finish.");
  } finally {
    await host.stop({ stopLocalEnvironments: lifecycle.stopLocalEnvironments });
  }
}
if (import.meta.main) {
  void runLocalHost(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
