import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import { cleanupOwnedBattle, HostingService } from "../service";
import {
  ownedBattleSessionBundle,
  withOwnedBattleSession,
} from "../simulator-battle-session-bundle";
import { receiveOwnedSimulatorClock } from "../simulator-clock-bootstrap";
import { withSimulatorSession } from "../simulator-session";
import { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";

const settings = {
  endpoint: "http://127.0.0.1:1234",
  region: "ap-northeast-1",
  readToken: () => "private-test-token-value",
};
async function clock() {
  const pipe = new PassThrough();
  const result = receiveOwnedSimulatorClock(pipe);
  pipe.end(
    `${JSON.stringify({
      version: 2,
      domain: `mono-${"a".repeat(32)}`,
      key: "b".repeat(64),
      clock: "linux-clock-monotonic",
    })}\n`,
  );
  return result;
}
function service(bundle?: ReturnType<typeof ownedBattleSessionBundle>) {
  const host = new HostStore(new Database(":memory:"));
  const engine = new ExerciseFixture(() => new Database(":memory:"));
  return {
    host,
    service: new HostingService(
      host,
      engine,
      "fixture-key",
      undefined,
      undefined,
      undefined,
      undefined,
      bundle,
    ),
  };
}

test("explicit endpoint without owned bootstrap never constructs a Battle bundle", async () => {
  await withSimulatorSession(
    { dataDirectory: "/fixture", simulator: settings },
    new AbortController().signal,
    async (actual, signal, ownedClock) => {
      expect(ownedClock).toBeUndefined();
      expect(ownedBattleSessionBundle(actual, signal, ownedClock)).toBeUndefined();
    },
  );
  const f = service();
  try {
    expect(f.service.ownedBattleSession).toBeUndefined();
  } finally {
    f.host.close();
  }
});

test("owned session bundle reaches service privately without changing catalog or exposing credentials", async () => {
  const ownedClock = await clock();
  const controller = new AbortController();
  const bundle = ownedBattleSessionBundle(settings, controller.signal, ownedClock);
  const composed = withOwnedBattleSession({ publicValue: "visible" }, bundle);
  expect(composed.ownedBattleSession).toBe(bundle);
  expect(Object.keys(composed)).toEqual(["publicValue"]);
  expect({ ...composed }).toEqual({ publicValue: "visible" });
  expect(JSON.stringify(composed)).toBe('{"publicValue":"visible"}');
  for (const text of [
    JSON.stringify(bundle),
    inspect(bundle),
    inspect(composed, { showHidden: true }),
  ]) {
    expect(text).not.toContain("private-test-token-value");
    expect(text).not.toContain("b".repeat(64));
    expect(text).not.toContain(ownedClock.domain);
  }
  const f = service(composed.ownedBattleSession);
  try {
    expect(f.service.ownedBattleSession).toBe(bundle);
    expect(Object.keys(f.service)).not.toContain("ownedBattleSession");
    expect(f.service.engine.catalog().some((p) => p.problemId === "hello-world-battle")).toBe(
      false,
    );
    expect(
      await bundle?.run((session) => ({
        sameClock: session.clock === ownedClock,
        sameSignal: session.signal === controller.signal,
      })),
    ).toEqual({ sameClock: true, sameSignal: true });
    controller.abort();
    expect(() => f.service.ownedBattleSession).toThrow();
    await expect(bundle?.run(() => "must not run")).rejects.toThrow();
  } finally {
    f.host.close();
  }
});

test("session cancellation during callback cannot return a successful bundle operation", async () => {
  const controller = new AbortController();
  const bundle = ownedBattleSessionBundle(settings, controller.signal, await clock());
  if (!bundle) throw new Error("owned fixture bundle missing");
  await expect(
    bundle.run(async () => {
      controller.abort();
      return "stale success";
    }),
  ).rejects.toThrow();
  expect(() => ownedBattleSessionBundle(settings, controller.signal, undefined)).not.toThrow();
});

test("managed lifecycle conveys the owned clock and drains callback before stopping", async () => {
  const ownedClock = await clock();
  const order: string[] = [];
  let retained: ReturnType<typeof ownedBattleSessionBundle>;
  const environment = process.env;
  process.env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !/^(http|https|all)_proxy$/iu.test(key)),
  );
  try {
    await withSimulatorSession(
      {
        dataDirectory: "/fixture",
        managedSimulator: {
          binary: "/fixture/native",
          battle: {
            binarySha256: "a".repeat(64),
            runtimeConfigPath: "/fixture/runtime",
            runtimeConfigSha256: "c".repeat(64),
          },
        },
      },
      new AbortController().signal,
      async (actual, signal, actualClock) => {
        retained = ownedBattleSessionBundle(actual, signal, actualClock);
        const f = service(retained);
        try {
          await f.service.ownedBattleSession?.run(({ clock: received }) => {
            expect(received).toBe(ownedClock);
            order.push("drained");
          });
        } finally {
          f.host.close();
        }
      },
      {
        start: async () => ({
          settings: { ...settings, tokenFile: "/fixture/token" },
          clock: ownedClock,
          stop: async () => {
            order.push("stopped");
          },
          exited: new Promise(() => {
            /* Owned fake remains alive until stop. */
          }),
        }),
      },
    );
    expect(order).toEqual(["drained", "stopped"]);
    expect(() => retained?.assertActive()).toThrow();
  } finally {
    process.env = environment;
  }
});

test("shutdown cleanup retains exact ownership on success and failure and continues other jobs", async () => {
  const { seed } = await import("./simulator-battle-journal-fixture");
  const bundle = ownedBattleSessionBundle(settings, new AbortController().signal, await clock());
  if (!bundle) throw new Error("Owned fixture required");
  const calls: string[] = [];
  const f = service({
    ...bundle,
    cleanup: async (owner) => {
      calls.push(owner.teamId);
      if (owner.teamId === "failed") throw new Error("Unconfirmed provider response");
      return { sealed: true, joined: true };
    },
  });
  try {
    const failed = seed(f.host, "failed");
    const other = seed(f.host, "other");
    failed.status = "FAILED";
    f.host.putJob(failed);
    await expect(cleanupOwnedBattle(f.service)).rejects.toThrow("unconfirmed");
    expect(calls.sort()).toEqual(["failed", "other"]);
    expect(f.host.job(failed.jobId).unit).toBe(failed.unit);
    expect(f.host.job(other.jobId).unit).toBe(other.unit);
    expect(f.host.job(failed.jobId).status).toBe("FAILED");
    expect(f.host.job(other.jobId).status).toBe("COMPLETE");
  } finally {
    f.host.close();
  }
});
