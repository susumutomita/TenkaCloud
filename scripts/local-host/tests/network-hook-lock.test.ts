import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { LinuxNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan } from "../local-network";
import {
  networkHookWorkerContext,
  releaseNetworkHookWorker,
  withNetworkHookLock,
} from "../network-hook-lock";
import { NativeVpnBackend } from "../vpn/native-backend";
import { fixture, plan } from "./vpn-kernel-fixture";

function holder(crash = false, inspect = false, crashDelay = 0) {
  const hookLock = networkHookWorkerContext();
  const trace = new SharedArrayBuffer(4);
  const worker = new Worker(new URL("./network-hook-worker-fixture.ts", import.meta.url), {
    workerData: { hookLock, trace, crash, inspect, crashDelay },
  });
  const held = new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  return { hookLock, trace: new Int32Array(trace), worker, held, exited };
}
for (const operation of ["seal", "prepare", "commit"] as const)
  test(`synchronous VPN ${operation} waits for worker-owned hook positions without the controller event loop`, async () => {
    const f = fixture();
    f.ingress.seal();
    const proof = f.ingress.prepare([]);
    const held = holder();
    await held.held;
    let commands = 0;
    const backend = new NativeVpnBackend(plan, {
      ...f.io,
      run: (call) => {
        if (
          operation !== "prepare" ||
          call.command.endsWith("-restore") ||
          call.args.includes("-I")
        )
          expect(Atomics.load(held.trace, 0)).toBe(1);
        commands++;
        return f.io.run(call);
      },
    });
    try {
      if (operation === "commit") backend.commit(proof);
      else if (operation === "prepare") backend.prepare([]);
      else backend.seal();
      expect(commands).toBeGreaterThan(0);
    } finally {
      await held.exited;
    }
  });

test("a crashed worker cannot release another owner's lock", async () => {
  const held = holder(true);
  await held.held;
  await held.exited;
  const state = new Int32Array(held.hookLock.buffer);
  expect(Atomics.load(state, 0)).toBe(held.hookLock.owner);
  if (process.platform === "linux") {
    withNetworkHookLock(() => expect(Atomics.load(state, 0)).toBe(1), 1500);
    expect(Atomics.load(state, 0)).toBe(0);
  } else expect(() => withNetworkHookLock(() => undefined, 1)).toThrow("ordering timed out");
  releaseNetworkHookWorker(held.hookLock);
  expect(() =>
    withNetworkHookLock(() => {
      releaseNetworkHookWorker(held.hookLock);
      expect(Atomics.load(state, 0)).toBe(1);
      throw new Error("Synthetic native failure");
    }),
  ).toThrow("Synthetic native failure");
  expect(Atomics.load(state, 0)).toBe(0);
});

for (const terminated of [false, true])
  test.skipIf(process.platform !== "linux")(
    `a synchronous seal reclaims a ${terminated ? "terminated" : "crashed"} worker's lock without the controller event loop`,
    async () => {
      const held = holder(true, false, 100);
      await held.held;
      const f = fixture();
      const start = performance.now();
      let controllerObservedExit = false;
      void held.exited.then(() => {
        controllerObservedExit = true;
      });
      if (terminated) void held.worker.terminate();
      try {
        withNetworkHookLock(() => f.ingress.seal(), 1500);
        expect(f.sealed()).toBe(true);
        expect(controllerObservedExit).toBe(false);
        expect(performance.now() - start).toBeLessThan(1500);
      } finally {
        await held.exited;
        releaseNetworkHookWorker(held.hookLock);
      }
    },
  );

for (const mode of ["uninitialized", "live", "unreadable"] as const)
  test.skipIf(process.platform !== "linux")(
    `a ${mode} worker task never permits ownership reclamation`,
    () => {
      const worker = networkHookWorkerContext();
      const state = new Int32Array(worker.buffer);
      Atomics.store(state, 0, worker.owner);
      if (mode !== "uninitialized")
        Atomics.store(
          new Int32Array(worker.thread),
          0,
          Number(fs.readlinkSync("/proc/thread-self").split("/").at(-1)),
        );
      const stat =
        mode === "unreadable"
          ? spyOn(fs, "statSync").mockImplementation((path) => {
              throw Object.assign(new Error("Synthetic proc inventory failure"), {
                code: path === "/proc/self/task" ? "EACCES" : "ENOENT",
              });
            })
          : undefined;
      let ran = false;
      try {
        expect(() =>
          withNetworkHookLock(() => {
            ran = true;
          }, 20),
        ).toThrow(
          mode === "unreadable" ? "Synthetic proc inventory failure" : "ordering timed out",
        );
        expect(ran).toBe(false);
        expect(Atomics.load(state, 0)).toBe(worker.owner);
      } finally {
        stat?.mockRestore();
        releaseNetworkHookWorker(worker);
      }
    },
  );

test("native guard installation releases its hook lock when the restore fails", () => {
  const state = new Int32Array(networkHookWorkerContext().buffer);
  const guard = new LinuxNetworkGuard({
    platform: "linux",
    read: () => "",
    exists: () => false,
    link: () => "net:[1]",
    run: ({ command }) => {
      if (command.endsWith("-restore")) {
        expect(Atomics.load(state, 0)).toBe(1);
        throw new Error("Synthetic restore failure");
      }
      return "";
    },
  });
  Reflect.set(guard, "preflight", () => undefined);
  Reflect.set(guard, "assertOwnership", () => undefined);
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic plan only
  const network = localNetworkPlan("tch-lock-install", { default: "10.249.0.0/28" });
  expect(() => guard.install(network)).toThrow("Synthetic restore failure");
  expect(Atomics.load(state, 0)).toBe(0);
});

test("VPN lifecycle seal and another request progress while installation waits on Docker inspection", async () => {
  const held = holder(false, true);
  await held.held;
  try {
    const f = fixture();
    f.ingress.seal();
    expect(f.sealed()).toBe(true);
    let heartbeat = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        heartbeat = true;
        resolve();
      }, 0),
    );
    expect(heartbeat).toBe(true);
    expect(Atomics.load(held.trace, 0)).toBe(0);
  } finally {
    Atomics.store(held.trace, 0, 1);
    Atomics.notify(held.trace, 0);
    await held.exited;
  }
});

test("a hard seal revokes peer identity even when its native hook lock times out", () => {
  const f = fixture();
  f.ingress.seal();
  f.ingress.commit(f.ingress.prepare([]));
  const foreign = networkHookWorkerContext();
  const state = new Int32Array(foreign.buffer);
  Atomics.store(state, 0, foreign.owner);
  const clock = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(120_001);
  try {
    expect(() => f.ingress.seal()).toThrow("ordering timed out");
    expect(() =>
      f.ingress.authorize(plan.peers[0]?.ipv4 ?? "", { eventId: "event", teamId: "alpha" }),
    ).toThrow();
  } finally {
    clock.mockRestore();
    releaseNetworkHookWorker(foreign);
  }
  f.ingress.seal();
  expect(f.sealed()).toBe(true);
});
