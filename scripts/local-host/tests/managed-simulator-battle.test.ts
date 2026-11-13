import { afterEach, expect, test } from "bun:test";
import type { SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startManagedSimulator } from "../managed-simulator";
import type { prepareOwnedSimulatorLaunch } from "../simulator-owned-launch";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const domain = `mono-${"a".repeat(32)}`;
const envelope = `{"version":2,"domain":"${domain}","key":"${"b".repeat(64)}","clock":"linux-clock-monotonic"}\n`;
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly proof = new PassThrough();
  readonly stdio = [null, this.stdout, null, this.proof];
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  ready() {
    this.stdout.write("AWS simulation endpoint http://127.0.0.1:12345\n");
  }
  prove() {
    this.proof.end(Buffer.from(envelope));
  }
  exit() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}
function fixture(disposeError = false, failure?: "close" | "spawn") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "battle-managed-fake-")));
  directories.push(directory);
  const child = new FakeChild();
  const controller = new AbortController();
  let disposed = 0,
    closed = 0,
    spawned = 0;
  const prepare = (() => ({
    command: process.execPath,
    args: ["--fake-owned"],
    fd: 99,
    closeDescriptor: () => {
      closed++;
      if (failure === "close") throw new Error("descriptor close failure");
    },
    dispose: () => {
      disposed++;
      if (disposeError) throw new Error("cleanup retained failure");
    },
  })) as typeof prepareOwnedSimulatorLaunch;
  const fakeSpawn = ((_command: string, _args: readonly string[], options: SpawnOptions) => {
    spawned++;
    if (failure === "spawn") throw new Error("secret spawn failure");
    expect(options?.stdio).toEqual(["ignore", "pipe", "ignore", "pipe", 99]);
    return child;
  }) as unknown as typeof spawn;
  const start = () =>
    startManagedSimulator(
      {
        binary: process.execPath,
        dataDirectory: directory,
        signal: controller.signal,
        startupTimeoutMs: 100,
        battle: {
          binarySha256: "0".repeat(64),
          runtimeConfigSha256: "1".repeat(64),
          runtimeConfigPath: "/fake/runtime.json",
        },
      },
      { spawn: fakeSpawn, prepare },
    );
  return { child, controller, start, counts: () => ({ disposed, closed, spawned }) };
}
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
for (const order of ["ready-first", "proof-first"] as const) {
  test(`owned Battle awaits both endpoint and proof: ${order}`, async () => {
    const f = fixture();
    let settled = false;
    const pending = f.start().then((value) => {
      settled = true;
      return value;
    });
    if (order === "ready-first") f.child.ready();
    else f.child.prove();
    await nextTurn();
    expect(settled).toBe(false);
    if (order === "ready-first") f.child.prove();
    else f.child.ready();
    const managed = await pending;
    expect(managed.settings.endpoint).toBe("http://127.0.0.1:12345");
    expect(managed.clock?.domain).toBe(domain);
    f.child.exit();
    await managed.stop();
    await managed.stop();
    expect(f.counts()).toEqual({ spawned: 1, closed: 1, disposed: 1 });
    expect(() => managed.clock?.authenticateSample({}, "0".repeat(64))).toThrow("no longer live");
  });
}
test("early child exit cannot become ready even with both outputs", async () => {
  const f = fixture();
  const pending = f.start();
  f.child.ready();
  f.child.prove();
  f.child.exit();
  await expect(pending).rejects.toThrow("could not start");
  expect(f.counts().disposed).toBe(1);
});
test("abort during startup stops owned child and disposes launch once", async () => {
  const f = fixture();
  const pending = f.start();
  f.controller.abort();
  f.child.exit();
  await expect(pending).rejects.toThrow();
  expect(f.child.stdout.destroyed).toBe(true);
  expect(f.child.proof.destroyed).toBe(true);
  expect(f.counts().disposed).toBe(1);
});
test("stop retains cleanup failure without unhandled rejection on abort", async () => {
  const f = fixture(true);
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    const pending = f.start();
    f.child.ready();
    f.child.prove();
    const managed = await pending;
    f.controller.abort();
    f.child.exit();
    await expect(managed.stop()).rejects.toThrow("cleanup retained failure");
    await expect(managed.stop()).rejects.toThrow("cleanup retained failure");
    await nextTurn();
    expect(unhandled).toEqual([]);
    expect(f.counts().disposed).toBe(1);
  } finally {
    process.removeListener("unhandledRejection", record);
  }
});

test("descriptor failure before Promise.all cleans up without floating ready/proof rejection", async () => {
  const f = fixture(false, "close");
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    const pending = f.start();
    f.child.exit();
    await expect(pending).rejects.toThrow("descriptor close failure");
    await nextTurn();
    expect(unhandled).toEqual([]);
    expect(f.child.proof.destroyed).toBe(true);
    expect(f.counts()).toEqual({ spawned: 1, closed: 1, disposed: 1 });
  } finally {
    process.removeListener("unhandledRejection", record);
  }
});
test("synchronous spawn exception disposes owned launch and withholds diagnostics", async () => {
  const f = fixture(false, "spawn");
  await expect(f.start()).rejects.toThrow("Managed Simulator could not start.");
  expect(f.counts()).toEqual({ spawned: 1, closed: 0, disposed: 1 });
});
test("returned clock is invalidated immediately by stop before child exit", async () => {
  const f = fixture();
  const pending = f.start();
  f.child.ready();
  f.child.prove();
  const managed = await pending;
  const stopping = managed.stop();
  expect(f.child.exitCode).toBeNull();
  expect(() => managed.clock?.authenticateSample({}, "0".repeat(64))).toThrow("no longer live");
  f.child.exit();
  await stopping;
  expect(f.counts().disposed).toBe(1);
});
