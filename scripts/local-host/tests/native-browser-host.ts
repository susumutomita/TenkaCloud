/** Production local host wiring with a parent-owned disposable SQLite directory.
 * The parent restarts this process over the same directory; this fixture never
 * deletes it or prints credentials. No Docker problem is offered or executed.
 */
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stop } from "esbuild";
import { CompetitionEngine } from "../competition-engine";
import { type RunningLocalHost, startLocalHost } from "../server";

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const data = process.env.HOST_NATIVE_DATA;
  if (!data || process.env.HOST_E2E_KEY_FD !== "3")
    throw new Error("Native browser fixture needs its owned data directory and private pipe");
  let finish: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  process.once("SIGTERM", finish);
  process.once("SIGINT", finish);
  let host: RunningLocalHost | undefined;
  try {
    host = await startLocalHost(
      root,
      {
        dataDirectory: data,
        hostname: "127.0.0.1",
        adminPort: Number(process.env.HOST_NATIVE_ADMIN_PORT ?? 0),
        participantPort: Number(process.env.HOST_NATIVE_PARTICIPANT_PORT ?? 0),
        gatewayPorts: { start: 5300, end: 5339 },
      },
      (directory) => new CompetitionEngine(root, directory, false),
      (message) => console.error(message),
    );
    writeSync(3, `${host.organizerKey ?? "restored"}\n`);
    console.log(
      JSON.stringify({
        admin: host.admin.origin,
        participant: host.participant.origin,
        engine: "coordination",
      }),
    );
    await stopped;
  } finally {
    await host?.stop();
    await stop();
    process.off("SIGTERM", finish);
    process.off("SIGINT", finish);
  }
}
if (import.meta.main)
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
