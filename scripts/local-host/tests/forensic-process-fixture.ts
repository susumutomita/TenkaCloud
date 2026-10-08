/** Browser fixture restarts a separate host process, retaining only its owned SQLite directory. */
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { stop as stopBundler } from "esbuild";
import { CompetitionEngine } from "../competition-engine";
import { parseGatewayPorts } from "../gateway-ports";
import { type PrivateKeyProcess, spawnPrivateKeyProcess } from "../private-key-process";
import { type RunningLocalHost, startLocalHost } from "../server";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { forensicRoot, required } from "./forensic-fixture";

interface ProcessInfo {
  admin: { origin: string };
  participant: { origin: string };
  pid: number;
}

async function startProcess(directory: string) {
  const processHandle = spawnPrivateKeyProcess(
    [process.execPath, "run", fileURLToPath(import.meta.url)],
    {
      cwd: forensicRoot,
      env: { ...process.env, FORENSIC_HOST_DATA: directory, HOST_E2E_KEY_FD: "3" },
    },
  );
  const publicLines = createInterface({ input: processHandle.stdout });
  const privateLines = createInterface({ input: processHandle.privateOutput });
  processHandle.stderr.pipe(process.stderr);
  function line<T>(lines: ReturnType<typeof createInterface>, parse: (line: string) => T) {
    return new Promise<T>((resolve, reject) => {
      void processHandle.child.exited.then(
        (code) => reject(new Error(`Forensic host exited before readiness (${String(code)}).`)),
        reject,
      );
      lines.once("line", (value) => {
        try {
          resolve(parse(value));
        } catch {
          reject(new Error("Invalid forensic host readiness response."));
        }
      });
    });
  }
  try {
    const [host, key] = await Promise.all([
      line(publicLines, (value) => JSON.parse(value) as ProcessInfo),
      line(privateLines, (value) => {
        assert.ok(value === "" || /^[A-Za-z0-9_-]{43}$/u.test(value));
        return value;
      }),
    ]);
    return { host, key, processHandle };
  } catch (error) {
    await stopProcess(processHandle);
    throw error;
  } finally {
    publicLines.close();
    privateLines.close();
    processHandle.stdout.resume();
    processHandle.privateOutput.resume();
  }
}

async function stopProcess(processHandle: PrivateKeyProcess) {
  const { child } = processHandle;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  assert.equal(await processHandle.exited, 0, "The forensic host closes its owned SQLite cleanly.");
}

export async function forensicProcessFixture() {
  const directory = createTemporaryDirectory(forensicRoot, "tenka-forensic-browser-");
  let running: Awaited<ReturnType<typeof startProcess>> | undefined;
  try {
    running = await startProcess(directory);
  } catch (error) {
    removeTemporaryDirectory(forensicRoot, directory);
    throw error;
  }
  const key = running.key;
  assert.ok(key, "The fresh fixture receives its organizer key via the private pipe.");
  return {
    get host() {
      return required(running).host;
    },
    key,
    async restart() {
      const previous = required(running);
      running = undefined;
      await stopProcess(previous.processHandle);
      running = await startProcess(directory);
      assert.notEqual(running.host.pid, previous.host.pid, "Restart uses a fresh OS process.");
      assert.equal(running.key, "", "Restart never rediscloses the organizer key.");
    },
    async close() {
      if (running) await stopProcess(running.processHandle);
      running = undefined;
      removeTemporaryDirectory(forensicRoot, directory);
    },
  };
}

async function childMain() {
  const directory = required(process.env.FORENSIC_HOST_DATA);
  assert.equal(process.env.HOST_E2E_KEY_FD, "3");
  let host: RunningLocalHost | undefined;
  let requestStop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);
  try {
    host = await startLocalHost(
      forensicRoot,
      {
        dataDirectory: directory,
        hostname: "127.0.0.1",
        adminPort: 0,
        participantPort: 0,
        gatewayPorts: parseGatewayPorts("5840-5879"),
      },
      (data) => new CompetitionEngine(forensicRoot, data, false),
      (message) => console.error(message),
    );
    writeSync(3, `${host.organizerKey ?? ""}\n`);
    console.log(
      JSON.stringify({
        admin: { origin: host.admin.origin },
        participant: { origin: host.participant.origin },
        pid: process.pid,
      }),
    );
    await stopped;
  } finally {
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    await host?.stop();
    await stopBundler();
  }
}

if (import.meta.main)
  void childMain().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
