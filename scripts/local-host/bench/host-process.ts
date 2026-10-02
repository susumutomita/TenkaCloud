import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { GatewayPortRange } from "../gateway-ports";
import { formatGatewayPorts } from "../gateway-ports";
import { portsFree } from "../ports";

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

/** Public startup addresses and the organizer key from the private parent pipe. */
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
  const database = /^State: (.+)$/u.exec(line);
  if (admin?.[1]) partial.adminOrigin = admin[1];
  if (participant?.[1]) partial.participantOrigin = participant[1];
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

/** Runs the production local host through the benchmark's private organizer-key wrapper. */
export async function spawnHostProcess(options: SpawnHostOptions): Promise<HostProcessHandle> {
  const child = spawn(
    process.execPath,
    [
      "run",
      "scripts/local-host/bench/host-entry.ts",
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
    { cwd: options.repositoryRoot, stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  try {
    return await waitForHostProcess(child, options.readyTimeoutMs);
  } catch (error) {
    await stopHostProcess(child);
    throw error;
  }
}

function waitForHostProcess(
  child: ChildProcess,
  readyTimeoutMs: number,
): Promise<HostProcessHandle> {
  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  const lines = createInterface({ input: child.stdout as Readable });
  const privateLines = createInterface({ input: child.stdio[3] as Readable });
  return new Promise<HostProcessHandle>((accept, reject) => {
    const partial: PartialHostProcessInfo = {};
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Local host did not become ready within ${String(readyTimeoutMs)}ms.`));
    }, readyTimeoutMs);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
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
      child.off("error", onError);
      lines.off("line", onLine);
      privateLines.off("line", onKey);
      lines.close();
      child.stdout?.resume();
      privateLines.close();
    }
    function onLine(line: string): void {
      parseStartupLine(line, partial);
      acceptReady();
    }
    function onKey(line: string): void {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(line)) {
        onError(new Error("Benchmark host returned an invalid private organizer key."));
        return;
      }
      partial.hostKey = line;
      acceptReady();
    }
    function acceptReady(): void {
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
    child.once("error", onError);
    lines.on("line", onLine);
    privateLines.on("line", onKey);
  });
}

async function stopHostProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  if (await waitForExit(child, 10_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 10_000)))
    throw new Error("Benchmark child did not exit; retaining its temporary data.");
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((accept) => {
    const onExit = () => {
      clearTimeout(timeout);
      accept(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      accept(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
