/* eslint-disable sonarjs/no-clear-text-protocols -- Numeric loopback is the simulator transport contract. */
import { afterEach, expect, test } from "bun:test";
import { parseOptions } from "../options";
import { withSimulatorSession } from "../simulator-session";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});
function noProxy() {
  process.env = Object.fromEntries(
    Object.entries(saved).filter(([key]) => !/^(http|https|all)_proxy$/iu.test(key)),
  );
}
const settings = {
  endpoint: "http://127.0.0.1:43210",
  tokenFile: "/private/token",
  region: "ap-northeast-1",
  bootstrap: true,
};
const options = { dataDirectory: "/private/host", managedSimulator: { binary: "/private/native" } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("loopback defaults to managed simulator; opt-out and explicit external connection do not", () => {
  expect(parseOptions([], "/fixture", {}).managedSimulator).toEqual({});
  expect(parseOptions(["--no-simulator"], "/fixture", {}).managedSimulator).toBeUndefined();
  expect(
    parseOptions(["--simulator-binary", "/fixture/native"], "/fixture", {}).managedSimulator,
  ).toEqual({
    binary: "/fixture/native",
  });
  expect(() =>
    parseOptions(["--no-simulator", "--simulator-binary", "/fixture/native"], "/fixture", {}),
  ).toThrow("cannot be combined");
  const args = [
    "--simulator-endpoint",
    settings.endpoint,
    "--simulator-token-file",
    settings.tokenFile,
    "--simulator-region",
    settings.region,
  ];
  expect(parseOptions(args, "/fixture", {}).managedSimulator).toBeUndefined();
  expect(() =>
    parseOptions([...args, "--simulator-binary", "/fixture/native"], "/fixture", {}),
  ).toThrow("only for automatic");
  expect(
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Parsing fixture only; no connection is made.
    parseOptions(["--lan", "192.168.1.2", "--unsafe-lan"], "/fixture", {}).managedSimulator,
  ).toBeUndefined();
});

test("explicit native binary bypasses download and shuts down after host drains", async () => {
  noProxy();
  const order: string[] = [];
  await withSimulatorSession(
    options,
    new AbortController().signal,
    async (actual) => {
      expect(actual).toEqual(settings);
      order.push("host drains");
    },
    {
      start: async (actual) => {
        expect(actual.binary).toBe(options.managedSimulator.binary);
        return {
          settings,
          exited: new Promise(() => {
            /* Intentionally remains alive during the test. */
          }),
          stop: async () => {
            order.push("simulator stops");
          },
        };
      },
      install: async () => {
        throw new Error("must not download");
      },
    },
  );
  expect(order).toEqual(["host drains", "simulator stops"]);
});

test("unexpected simulator exit aborts host, drains it, then reports failure", async () => {
  noProxy();
  const exit = deferred<{ code: number; signal: null }>();
  const order: string[] = [];
  await expect(
    withSimulatorSession(
      options,
      new AbortController().signal,
      async (_settings, signal) => {
        const stopped = new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        exit.resolve({ code: 17, signal: null });
        await stopped;
        order.push("host drains");
      },
      {
        start: async () => ({
          settings,
          exited: exit.promise,
          stop: async () => {
            order.push("simulator stops");
          },
        }),
      },
    ),
  ).rejects.toThrow("exited unexpectedly");
  expect(order).toEqual(["host drains", "simulator stops"]);
});

test("host startup failure still stops the owned simulator", async () => {
  noProxy();
  let stopped = false;
  await expect(
    withSimulatorSession(
      options,
      new AbortController().signal,
      async () => {
        throw new Error("host startup failed");
      },
      {
        start: async () => ({
          settings,
          exited: new Promise(() => {
            /* Intentionally remains alive during the test. */
          }),
          stop: async () => {
            stopped = true;
          },
        }),
      },
    ),
  ).rejects.toThrow("host startup failed");
  expect(stopped).toBe(true);
});

test("cancellation drains host before simulator stop and never downloads for opt-out", async () => {
  noProxy();
  const controller = new AbortController();
  const order: string[] = [];
  await withSimulatorSession(
    options,
    controller.signal,
    async (_settings, signal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      order.push("host drains");
    },
    {
      start: async () => ({
        settings,
        exited: new Promise(() => {
          /* Intentionally remains alive during the test. */
        }),
        stop: async () => {
          order.push("simulator stops");
        },
      }),
    },
  );
  expect(order).toEqual(["host drains", "simulator stops"]);
  await withSimulatorSession(
    { dataDirectory: "/private/host" },
    new AbortController().signal,
    async (actual) => {
      expect(actual).toBeUndefined();
    },
    {
      start: async () => {
        throw new Error("must not start");
      },
    },
  );
});

test("managed startup rejects proxy environment before downloading or launching", async () => {
  process.env.HTTPS_PROXY = "http://proxy.invalid";
  await expect(
    withSimulatorSession(
      options,
      new AbortController().signal,
      async () => {
        /* Host must never be reached. */
      },
      {
        start: async () => {
          throw new Error("must not start");
        },
      },
    ),
  ).rejects.toThrow("HTTP_PROXY");
});

test("proxy flags never silently discard an explicit native binary", () => {
  const args = ["--behind-proxy", "--simulator-binary", "/fixture/native"];
  expect(() => parseOptions(args, "/fixture", {})).toThrow("need the public origins");
  expect(() =>
    parseOptions(
      [
        ...args,
        "--public-admin-origin",
        "https://admin.example.test",
        "--public-participant-origin",
        "https://participant.example.test",
      ],
      "/fixture",
      {},
    ),
  ).toThrow("only for automatic same-machine simulator startup");
});

test("explicit release update is only available for automatic same-machine Simulator startup", () => {
  expect(parseOptions(["--update-simulator"], "/fixture", {}).managedSimulator).toEqual({
    update: true,
  });
  for (const extra of [
    ["--no-simulator"],
    ["--simulator-binary", "/fixture/native"],
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Private LAN parsing fixture; no connection is made.
    ["--lan", "10.10.10.10", "--unsafe-lan"],
  ])
    expect(() => parseOptions(["--update-simulator", ...extra], "/fixture", {})).toThrow(
      "--update-simulator",
    );
});

const battle = {
  binarySha256: "a".repeat(64),
  runtimeConfigPath: "/private/runtime.json",
  runtimeConfigSha256: "b".repeat(64),
};
const battleOptions = { ...options, managedSimulator: { ...options.managedSimulator, battle } };
test("Battle passes exact opt-in and owned clock without installer", async () => {
  noProxy();
  const clock = {
    domain: "synthetic-unit-test-only",
    authenticateResponse() {
      /* Fixture does not issue provider requests. */
    },
    authenticateSample() {
      throw new Error("not invoked");
    },
  };
  let stopped = 0;
  await withSimulatorSession(
    battleOptions,
    new AbortController().signal,
    async (actual, _signal, actualClock) => {
      expect(actual).toBe(settings);
      expect(actualClock).toBe(clock);
    },
    {
      start: async (actual) => {
        expect(actual.battle).toBe(battle);
        expect(actual.binary).toBe(options.managedSimulator.binary);
        return {
          settings,
          clock,
          exited: new Promise(() => {
            /* Injected child remains alive until explicit test cleanup. */
          }),
          stop: async () => {
            stopped++;
          },
        };
      },
      install: async () => {
        throw new Error("must not install");
      },
    },
  );
  expect(stopped).toBe(1);
});
test("Battle missing clock stops owned child without entering host callback", async () => {
  noProxy();
  let stopped = 0;
  let ran = false;
  await expect(
    withSimulatorSession(
      battleOptions,
      new AbortController().signal,
      async () => {
        ran = true;
      },
      {
        start: async () => ({
          settings,
          exited: new Promise(() => {
            /* Injected child remains alive until explicit test cleanup. */
          }),
          stop: async () => {
            stopped++;
          },
        }),
      },
    ),
  ).rejects.toThrow("owned Simulator clock");
  expect(stopped).toBe(1);
  expect(ran).toBe(false);
});
for (const managedSimulator of [
  { battle },
  { binary: " ", battle },
  { binary: "/private/native", battle, update: true },
]) {
  test(`Battle rejects unpinned selection/update before installer ${JSON.stringify(managedSimulator)}`, async () => {
    noProxy();
    let started = false;
    let installed = false;
    await expect(
      withSimulatorSession(
        { dataDirectory: options.dataDirectory, managedSimulator },
        new AbortController().signal,
        async () => {
          throw new Error("must not run");
        },
        {
          start: async () => {
            started = true;
            throw new Error("must not start");
          },
          install: async () => {
            installed = true;
            throw new Error("must not install");
          },
        },
      ),
    ).rejects.toThrow("explicit pinned binary");
    expect(started).toBe(false);
    expect(installed).toBe(false);
  });
}

test("normal shutdown drains cleanup before owned lifetime abort and process stop", async () => {
  noProxy();
  const shutdown = new AbortController();
  let lifetime: AbortSignal | undefined;
  const order: string[] = [];
  await withSimulatorSession(
    options,
    shutdown.signal,
    async (_settings, signal, _clock, owned) => {
      lifetime = owned;
      shutdown.abort();
      expect(signal.aborted).toBe(true);
      expect(owned?.aborted).toBe(false);
      order.push("cleanup confirmed");
    },
    {
      start: async () => ({
        settings,
        exited: new Promise(() => {
          /* Provider remains alive until explicitly stopped. */
        }),
        stop: async () => {
          expect(lifetime?.aborted).toBe(true);
          order.push("process stopped");
        },
      }),
    },
  );
  expect(order).toEqual(["cleanup confirmed", "process stopped"]);
});
