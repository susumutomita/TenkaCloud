import { fileURLToPath } from "node:url";
import { buildHosting } from "./build";
import { DockerHostingEngine } from "./docker-engine";
import { DEFAULT_GATEWAY_PORTS, formatGatewayPorts } from "./gateway-ports";
import { parseOptions } from "./options";
import { startLocalHost } from "./server";

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const options = parseOptions(process.argv.slice(2), root);
  if (options.help) {
    console.log(
      `TenkaCloud local competition hosting\n\nbun start [--data <directory>] [--no-build]\n  --admin-port 5174       Host console; always loopback-only\n  --participant-port 5175 Participant portal\n  --gateway-ports ${DEFAULT_GATEWAY_PORTS}  Exercise gateways, one fixed port per team environment\n  --lan <private-ip> --unsafe-lan  Explicit unencrypted LAN hosting\n\nThe host application needs Bun and SQLite only. The sqli-demo problem requires Docker Compose.\nExisting make local individual practice is unchanged.`,
    );
    return;
  }
  if (process.platform === "win32")
    throw new Error("Native Windows is not supported; use WSL2 or a macOS/Linux host.");
  process.umask(0o077);
  if (options.build) await buildHosting(root);
  const host = await startLocalHost(
    root,
    options,
    (directory) => new DockerHostingEngine(root, directory),
  );
  try {
    const gateways = `http://${options.hostname}:${formatGatewayPorts(options.gatewayPorts)}`;
    console.log(
      `\nHost console: ${host.admin.origin}\nParticipant portal: ${host.participant.origin}\nExercise gateways: ${gateways} (one fixed port per team environment)\nHost login key: ${host.masterKey}\nState: ${host.databasePath}\n`,
    );
    if (options.hostname !== "127.0.0.1")
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
