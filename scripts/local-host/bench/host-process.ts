import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { GatewayPortRange } from "../gateway-ports";
import { formatGatewayPorts } from "../gateway-ports";
import { portsFree } from "../ports";

type HostChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface HostProcessInfo {
  readonly adminOrigin: string;
  readonly participantOrigin: string;
  readonly hostKey: string;
  readonly databasePath: string;
}
export interface HostProcessHandle {
  readonly info: HostProcessInfo;
  readonly pid: number;
  readonly databasePath: string;
  stop(): Promise<void>;
}

/** Mutable while the startup banner is still being parsed line by line. */
interface PartialHostProcessInfo {
  adminOrigin?: string;
  participantOrigin?: string;
  hostKey?: string;
  databasePath?: string;
}

/** Same startup output `bun start` prints (scripts/local-host/main.ts); parsed, not JSON. */
function parseStartupLine(line: string, partial: PartialHostProcessInfo): void {
  const admin = /^Host console: (.+)$/u.exec(line);
  const participant = /^Participant portal: (.+)$/u.exec(line);
  const key = /^Host login key: (.+)$/u.exec(line);
  const database = /^State: (.+)$/u.exec(line);
  if (admin?.[1]) partial.adminOrigin = admin[1];
  if (participant?.[1]) partial.participantOrigin = participant[1];
  if (key?.[1]) partial.hostKey = key[1];
  if (database?.[1]) partial.databasePath = database[1];
}

function isComplete(partial: PartialHostProcessInfo): partial is Required<PartialHostProcessInfo> {
  return Boolean(
    partial.adminOrigin && partial.participantOrigin && partial.hostKey && partial.databasePath,
  );
}

export async function assertPortsFree(
  adminPort: number,
  participantPort: number,
  gatewayPorts: GatewayPortRange,
): Promise<void> {
  const gatewayPortList = Array.from(
    { length: gatewayPorts.end - gatewayPorts.start + 1 },
    (_unused, index) => gatewayPorts.start + index,
  );
  const free = await portsFree([adminPort, participantPort, ...gatewayPortList], "127.0.0.1");
  if (!free)
    throw new Error(
      `One of --admin-port ${String(adminPort)}, --participant-port ${String(participantPort)} or ` +
        `--gateway-ports ${formatGatewayPorts(gatewayPorts)} is already bound on 127.0.0.1.`,
    );
}

export interface SpawnHostOptions {
  readonly repositoryRoot: string;
  readonly dataDirectory: string;
  readonly adminPort: number;
  readonly participantPort: number;
  readonly gatewayPorts: GatewayPortRange;
  readonly readyTimeoutMs: number;
}

/** Spawns the same entry point `bun start` runs, bypassing package.json script-arg forwarding. */
export function spawnHostProcess(options: SpawnHostOptions): Promise<HostProcessHandle> {
  const child: HostChildProcess = spawn(
    process.execPath,
    [
      "run",
      "scripts/local-host/main.ts",
      "--no-build",
      "--data",
      options.dataDirectory,
      "--admin-port",
      String(options.adminPort),
      "--participant-port",
      String(options.participantPort),
      "--gateway-ports",
      formatGatewayPorts(options.gatewayPorts),
    ],
    { cwd: options.repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderrChunks: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  const lines = createInterface({ input: child.stdout });
  return new Promise<HostProcessHandle>((accept, reject) => {
    const partial: PartialHostProcessInfo = {};
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Local host did not print its startup banner within ${String(options.readyTimeoutMs)}ms.`,
        ),
      );
    }, options.readyTimeoutMs);
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Local host exited before startup completed (code ${String(code)}).\n${stderrChunks.join("")}`,
        ),
      );
    };
    function cleanup(): void {
      clearTimeout(timeout);
      child.off("exit", onExit);
      lines.off("line", onLine);
    }
    function onLine(line: string): void {
      parseStartupLine(line, partial);
      if (!isComplete(partial)) return;
      cleanup();
      const info: HostProcessInfo = {
        adminOrigin: partial.adminOrigin,
        participantOrigin: partial.participantOrigin,
        hostKey: partial.hostKey,
        databasePath: partial.databasePath,
      };
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error("Local host process has no pid."));
        return;
      }
      accept({
        info,
        pid,
        databasePath: info.databasePath,
        stop: () => stopHostProcess(child),
      });
    }
    child.once("exit", onExit);
    lines.on("line", onLine);
  });
}

async function stopHostProcess(child: HostChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  const exited = await Promise.race([
    new Promise<boolean>((accept) => child.once("exit", () => accept(true))),
    new Promise<boolean>((accept) => setTimeout(() => accept(false), 10_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
