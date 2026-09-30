import { fileURLToPath } from "node:url";
import { buildHosting } from "./build";
import { connectCloudHosting } from "./cloud-hosting";
import { CompetitionEngine } from "./competition-engine";
import { DEFAULT_GATEWAY_PORTS, formatGatewayPorts } from "./gateway-ports";
import { parseOptions } from "./options";
import { startLocalHost } from "./server";

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const options = parseOptions(process.argv.slice(2), root);
  if (options.help) {
    console.log(
      `TenkaCloud local competition hosting\n\nbun start [--data <directory>] [--no-build]\n  --admin-port 5174       Host console; always loopback-only\n  --participant-port 5175 Participant portal\n  --gateway-ports ${DEFAULT_GATEWAY_PORTS}  Exercise gateways, one fixed port per team environment\n  --lan <private-ip> --unsafe-lan  Explicit unencrypted LAN hosting\n  --public-admin-origin https://… --public-participant-origin https://…  Behind a TLS-terminating proxy that passes the original Host header\n  --behind-proxy          Rate-limit by the proxy-appended X-Forwarded-For entry\n  --aws-region <region>   Offer AWS problems, deployed into each team's competitor account with the AWS SDK's default credentials\n\nThe host application and Cryptography Battle need Bun and SQLite only. The sqli-demo problem requires Docker Compose. The hello-world problem requires --aws-region.\nExisting make local individual practice is unchanged.`,
    );
    return;
  }
  if (process.platform === "win32")
    throw new Error("Native Windows is not supported; use WSL2 or a macOS/Linux host.");
  process.umask(0o077);
  const cloud = options.awsRegion
    ? await connectCloudHosting(root, options.dataDirectory, options.awsRegion)
    : undefined;
  if (options.build) await buildHosting(root);
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
    if (options.public) {
      // Container logs are shipped and retained elsewhere; the key stays in the data volume.
      console.log(
        `\nHost console: ${host.admin.origin}\nParticipant portal: ${host.participant.origin}\nHost login key: stored in ${host.masterKeyPath}\nState: ${host.databasePath}\nDocker Compose problems are not offered in public mode.\n`,
      );
    } else {
      const gateways = `http://${options.hostname}:${formatGatewayPorts(options.gatewayPorts)}`;
      console.log(
        `\nHost console: ${host.admin.origin}\nParticipant portal: ${host.participant.origin}\nExercise gateways: ${gateways} (one fixed port per team environment)\nHost login key: ${host.masterKey}\nState: ${host.databasePath}\n`,
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
      "Create an event, deploy its problem environments, distribute team keys, then start the event.\nCtrl+C stops the host server but preserves results and Docker environments. Use Teardown in the host console to remove environments.",
    );
    await new Promise<void>((accept) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        accept();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    console.log("Closing listeners; waiting for in-flight environment operations to finish.");
  } finally {
    await host.stop();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
