import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startManagedSimulator } from "../managed-simulator";

const directories: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(body: string) {
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), "managed-simulator-test-")));
  directories.push(dataDirectory);
  const binary = join(dataDirectory, "fixture.sh");
  writeFileSync(binary, `#!/bin/sh\nset -eu\ntrap 'exit 0' TERM INT\n${body}\n`, { mode: 0o700 });
  return { binary, dataDirectory, startupTimeoutMs: 2000 };
}
const ready = 'printf "AWS simulation endpoint http://127.0.0.1:43210\\n"';
const hold = 'trap "exit 0" TERM INT\nwhile :; do sleep 0.1; done';

describe("managed native Simulator", () => {
  test("passes isolated loopback and persistent private paths without reading credentials", async () => {
    const options = fixture(
      `printf '%s\\n' "$@" > "$START_STATE.args"\nprintf '%s' "$CI" > "$START_STATE.ci"\numask 077\nprintf 'synthetic-state' > "$START_STATE"\nprintf 'synthetic-token-never-read' > "$START_TOKEN_FILE"\n${ready}\n${hold}`,
    );
    const simulator = await startManagedSimulator(options);
    stops.push(simulator.stop);
    expect(simulator.settings).toEqual({
      endpoint: "http://127.0.0.1:43210",
      tokenFile: join(options.dataDirectory, "simulator/simulator-token"),
      region: "ap-northeast-1",
      bootstrap: true,
    });
    const state = join(options.dataDirectory, "simulator/practice.db");
    expect(readFileSync(`${state}.args`, "utf8").split("\n")).toEqual([
      "--listen=127.0.0.1:0",
      `--state=${state}`,
      `--token-file=${simulator.settings.tokenFile}`,
      "",
    ]);
    expect(readFileSync(`${state}.ci`, "utf8")).toBe("1");
    expect(lstatSync(join(options.dataDirectory, "simulator")).mode & 0o777).toBe(0o700);
    await Promise.all([simulator.stop(), simulator.stop()]);
    expect(existsSync(state)).toBe(true);
    expect(lstatSync(state).mode & 0o777).toBe(0o600);
    expect(existsSync(simulator.settings.tokenFile)).toBe(true);
    expect((await simulator.exited).code).toBe(0);
  });
  test("reuses retained state and token across starts without replacement", async () => {
    const options = fixture(`${ready}\n${hold}`);
    const first = await startManagedSimulator(options);
    stops.push(first.stop);
    const state = join(options.dataDirectory, "simulator/practice.db");
    writeFileSync(state, "retained state");
    writeFileSync(first.settings.tokenFile, "retained synthetic token", { mode: 0o600 });
    const tokenInode = lstatSync(first.settings.tokenFile).ino;
    await first.stop();
    const second = await startManagedSimulator(options);
    stops.push(second.stop);
    expect(second.settings.tokenFile).toBe(first.settings.tokenFile);
    expect(lstatSync(second.settings.tokenFile).ino).toBe(tokenInode);
    expect(readFileSync(state, "utf8")).toBe("retained state");
  });
  test("reports early exit without exposing stdout or stderr", async () => {
    const options = fixture("echo synthetic-secret; echo synthetic-secret >&2; exit 19");
    await expect(startManagedSimulator(options)).rejects.toThrow(
      "Managed Simulator could not start",
    );
  });
  test("rejects missing executable with actionable error", async () => {
    const options = fixture("exit 0");
    await expect(
      startManagedSimulator({ ...options, binary: `${options.binary}.missing` }),
    ).rejects.toThrow("missing or not executable");
  });
  test("ignores remote, zero, oversized, credential-bearing and overlong readiness lines", async () => {
    const options = fixture(
      `printf '%s\\n' 'AWS simulation endpoint http://example.com:4566' 'AWS simulation endpoint http://127.0.0.1:0' 'AWS simulation endpoint http://127.0.0.1:65536' 'AWS simulation endpoint http://user:secret@127.0.0.1:4566' '${"x".repeat(512)}AWS simulation endpoint http://127.0.0.1:43210'\n${hold}`,
    );
    await expect(startManagedSimulator({ ...options, startupTimeoutMs: 100 })).rejects.toThrow(
      "timed out",
    );
  });
  test("handles abort before launch and during startup", async () => {
    const options = fixture(hold);
    await expect(
      startManagedSimulator({ ...options, signal: AbortSignal.abort() }),
    ).rejects.toThrow("cancelled");
    expect(existsSync(join(options.dataDirectory, "simulator"))).toBe(false);
    const controller = new AbortController();
    const started = startManagedSimulator({ ...options, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(started).rejects.toThrow("cancelled");
  });
  test("propagates unexpected child exit after readiness", async () => {
    const options = fixture(`${ready}\nsleep 0.05\nexit 17`);
    const simulator = await startManagedSimulator(options);
    stops.push(simulator.stop);
    expect(await simulator.exited).toEqual({ code: 17, signal: null });
  });
  test("bounds stop of a TERM-resistant child and leaves unrelated processes alone", async () => {
    const unrelated = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    stops.push(async () => {
      if (unrelated.pid) process.kill(-unrelated.pid, "SIGKILL");
    });
    const options = fixture(`trap '' TERM\n${ready}\nwhile :; do sleep 0.1; done`);
    const simulator = await startManagedSimulator(options);
    stops.push(simulator.stop);
    const before = Date.now();
    await simulator.stop();
    expect(Date.now() - before).toBeLessThan(1800);
    expect((await simulator.exited).signal).toBe("SIGKILL");
    expect(unrelated.exitCode).toBeNull();
    const unrelatedPid = unrelated.pid;
    if (unrelatedPid === undefined) throw new Error("Fixture did not start");
    expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
  });
  test("stops owned descendants even after the direct child exits", async () => {
    const options =
      fixture(`/bin/sh -c 'trap '"'"'printf stopped > "$START_STATE.stopped"; exit 0'"'"' TERM; while :; do sleep 0.1; done' &
sleep 0.1
${ready}
sleep 0.05
exit 17`);
    const simulator = await startManagedSimulator(options);
    stops.push(simulator.stop);
    expect((await simulator.exited).code).toBe(17);
    await simulator.stop();
    expect(readFileSync(join(options.dataDirectory, "simulator/practice.db.stopped"), "utf8")).toBe(
      "stopped",
    );
  });
  test("keeps cancellation active after readiness", async () => {
    const controller = new AbortController();
    const options = fixture(`${ready}\n${hold}`);
    const simulator = await startManagedSimulator({ ...options, signal: controller.signal });
    stops.push(simulator.stop);
    controller.abort();
    expect((await simulator.exited).code).toBe(0);
  });
  test("refuses shared or symlinked state directories without modifying retained data", async () => {
    const options = fixture(hold);
    const directory = join(options.dataDirectory, "simulator");
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o755);
    await expect(startManagedSimulator(options)).rejects.toThrow("owner-only");
    chmodSync(directory, 0o700);
    const retained = join(options.dataDirectory, "retained");
    writeFileSync(retained, "retained data");
    symlinkSync(retained, join(directory, "practice.db"));
    await expect(startManagedSimulator(options)).rejects.toThrow("without links");
    expect(readFileSync(retained, "utf8")).toBe("retained data");
  });
});

test("rejects a symlinked data ancestor before creating simulator state", async () => {
  const options = fixture(hold);
  const real = join(options.dataDirectory, "real");
  mkdirSync(real, { mode: 0o700 });
  const alias = join(options.dataDirectory, "alias");
  symlinkSync(real, alias);
  await expect(startManagedSimulator({ ...options, dataDirectory: alias })).rejects.toThrow(
    "without symlinks",
  );
  expect(existsSync(join(real, "simulator"))).toBe(false);
});
