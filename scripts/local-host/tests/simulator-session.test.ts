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
