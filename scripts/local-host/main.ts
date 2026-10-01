import { fileURLToPath } from "node:url";
import { buildHosting } from "./build";
import { connectCloudHosting } from "./cloud-hosting";
import { CompetitionEngine } from "./competition-engine";
import { DEFAULT_GATEWAY_PORTS, formatGatewayPorts } from "./gateway-ports";
import { parseOptions } from "./options";
import { startLocalHost } from "./server";

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
  cloud: Awaited<ReturnType<typeof connectCloudHosting>> | undefined,
  stopLocalEnvironments: boolean,
): void {
  if (options.public) {
    // Container logs are shipped and retained elsewhere; the key stays in the data volume.
    console.log(
      `\nHost console: ${host.admin.origin}\nParticipant portal: ${host.participant.origin}\nHost login key: stored in ${host.masterKeyPath}\nState: ${host.databasePath}\nDocker Compose problems are not offered in public mode.\n`,
    );
  } else {
    const gateways = `http://${options.hostname}:${formatGatewayPorts(options.gatewayPorts)}`;
    console.log(
      `\nHost console: ${host.admin.origin}\nParticipant portal: ${host.participant.origin}\nExercise gateways: ${gateways} (active local environments only)\nHost login key: ${host.masterKey}\nState: ${host.databasePath}\n`,
    );
  }
  if (cloud) {
    // Like the host key: kept out of container logs, which platforms retain.
    const externalId = options.public ? `stored in ${cloud.externalIdPath}` : cloud.externalId;
    console.log(
      `AWS problems: region ${cloud.region}, operator account ${cloud.operatorAccountId}\nCompetitor ExternalId: ${externalId}`,
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

export async function runLocalHost(
  args: string[],
  lifecycle: { signal?: AbortSignal; stopLocalEnvironments?: boolean } = {},
): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const options = parseOptions(args, root);
  if (options.help) {
    console.log(
      `TenkaCloud local competition hosting\n\nmake local LOCAL_ARGS="[--data <directory>] [--no-build]"\n  --admin-port 5174       Host console; always loopback-only\n  --participant-port 5175 Participant portal\n  --gateway-ports ${DEFAULT_GATEWAY_PORTS}  Exercise gateways, leased only by active local environments\n  --max-active-per-team 3  Per-team local environment limit\n  --max-active-environments 12  Host-wide active environment limit\n  --container-memory-mib 4096  Sum of container memory caps, not a hardware benchmark\n  --lan <private-ip> --unsafe-lan  Explicit unencrypted LAN hosting\n  --public-admin-origin https://… --public-participant-origin https://…  Behind a TLS-terminating proxy that passes the original Host header\n  --behind-proxy          Rate-limit by the proxy-appended X-Forwarded-For entry\n  --aws-region <region>   Offer AWS problems, deployed into each team's competitor account with the AWS SDK's default credentials\n\nThe host application and Cryptography Battle need Bun and SQLite only. The local Challenge catalog requires Docker Compose. The hello-world problem requires --aws-region.\nmake local opens the unified competition console. make down stops local environments while retaining their data.`,
    );
    return;
  }
  if (process.platform === "win32")
    throw new Error("Native Windows is not supported; use WSL2 or a macOS/Linux host.");
  process.umask(0o077);
  if (lifecycle.signal?.aborted) return;
  const cloud = options.awsRegion
    ? await connectCloudHosting(root, options.dataDirectory, options.awsRegion)
    : undefined;
  if (options.build) await buildHosting(root);
  if (lifecycle.signal?.aborted) return;
  const host = await startLocalHost(
    root,
    { ...options, ...(cloud ? { accountConnection: cloud } : {}) },
    (directory, store) =>
      new CompetitionEngine(
        root,
        directory,
        !options.public,
        cloud?.engine((job) => store.team(job.teamId)),
      ),
  );
  try {
    announceHost(options, host, cloud, lifecycle.stopLocalEnvironments === true);
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
