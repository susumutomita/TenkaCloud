/* eslint-disable sonarjs/no-clear-text-protocols -- Numeric loopback is the simulator transport contract. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../options";
import { withSimulatorSession } from "../simulator-session";

const saved = { ...process.env };
const temporary: string[] = [];
afterEach(() => {
  process.env = { ...saved };
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const method of [console.log, console.warn] as unknown as { mockRestore?: () => void }[])
    method.mockRestore?.();
});
function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tc-session-"));
  temporary.push(directory);
  return directory;
}
function logs(): string[] {
  const lines: string[] = [];
  spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  return lines;
}
const running = {
  settings: {
    endpoint: "http://127.0.0.1:43210",
    tokenFile: "/private/token",
    region: "ap-northeast-1",
    bootstrap: true,
  },
  exited: new Promise<never>(() => {
    /* Intentionally remains alive. */
  }),
  stop: async () => undefined,
};
async function session(
  data: string,
  managedSimulator: { battleBundle?: string; update?: boolean; binary?: string },
  install: (args: Record<string, unknown>) => Promise<string> = async () => "/private/native",
) {
  noProxy();
  const started: { binary: string; battleBundle?: string }[] = [];
  await withSimulatorSession(
    { dataDirectory: data, managedSimulator },
    new AbortController().signal,
    async () => undefined,
    {
      start: async (actual) => {
        started.push(actual);
        return running;
      },
      install: install as never,
    },
  );
  return started;
}
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

test("a Battle bundle is only for automatic same-machine Simulator startup", () => {
  expect(
    parseOptions(["--battle-bundle", "/fixture/bundle"], "/fixture", {}).managedSimulator,
  ).toEqual({ battleBundle: "/fixture/bundle" });
  expect(
    parseOptions(
      ["--simulator-binary", "/fixture/native", "--battle-bundle", "/fixture/bundle"],
      "/fixture",
      {},
    ).managedSimulator,
  ).toEqual({ binary: "/fixture/native", battleBundle: "/fixture/bundle" });
  const external = [
    "--simulator-endpoint",
    settings.endpoint,
    "--simulator-token-file",
    settings.tokenFile,
    "--simulator-region",
    settings.region,
  ];
  for (const args of [
    ["--no-simulator", "--battle-bundle", "/fixture/bundle"],
    [...external, "--battle-bundle", "/fixture/bundle"],
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Parsing fixture only; no connection is made.
    ["--lan", "192.168.1.2", "--unsafe-lan", "--battle-bundle", "/fixture/bundle"],
    ["--battle-bundle", " "],
  ])
    expect(() => parseOptions(args, "/fixture", {})).toThrow("--battle-bundle");
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

test("managed startup always checks for a newer release, strict only with --update-simulator", async () => {
  const requests: Record<string, unknown>[] = [];
  const install = async (args: Record<string, unknown>) => {
    requests.push(args);
    return "/private/native";
  };
  await session(dataDirectory(), {}, install);
  await session(dataDirectory(), { update: true }, install);
  expect(requests.map((r) => [r.checkLatest, r.update])).toEqual([
    [true, undefined],
    [true, true],
  ]);
  expect(requests[0]?.cacheDirectory).toEndWith("simulator-binaries");
});

test("a version change copies practice.db before the new version opens it", async () => {
  const data = dataDirectory();
  mkdirSync(join(data, "simulator"));
  writeFileSync(join(data, "simulator", "practice.db"), "state bytes");
  const lines = logs();
  await session(data, {}, async (args) => {
    await (args.beforeVersionChange as (c: { from: string; to: string }) => Promise<void>)({
      from: "v0.1.0",
      to: "v0.2.0",
    });
    return "/private/native";
  });
  const backup = join(data, "simulator", "practice.db.v0.1.0.bak");
  expect(readFileSync(backup, "utf8")).toBe("state bytes");
  expect(lines.some((line) => line.includes(backup))).toBe(true);
});

test("a first update with no database yet has nothing to copy", async () => {
  const data = dataDirectory();
  await session(data, {}, async (args) => {
    await (args.beforeVersionChange as (c: { from: string; to: string }) => Promise<void>)({
      from: "v0.1.0",
      to: "v0.2.0",
    });
    return "/private/native";
  });
  expect(existsSync(join(data, "simulator"))).toBe(false);
});

test("an installer failure stops startup before any Simulator or Battle runtime starts", async () => {
  noProxy();
  const data = dataDirectory();
  await expect(
    withSimulatorSession(
      { dataDirectory: data, managedSimulator: {} },
      new AbortController().signal,
      async () => undefined,
      {
        install: async () => {
          throw new Error("Simulator release rejected");
        },
        start: async () => {
          throw new Error("must not start");
        },
      },
    ),
  ).rejects.toThrow("rejected");
});

test("the default Battle bundle is used when present and announced once", async () => {
  const data = dataDirectory();
  mkdirSync(join(data, "battle-bundle"));
  const lines = logs();
  const started = await session(data, {});
  expect(started[0]?.battleBundle).toBe(join(data, "battle-bundle"));
  expect(lines.filter((line) => line.startsWith("Battle VM runtime"))).toEqual([
    `Battle VM runtime: ${join(data, "battle-bundle")}`,
  ]);
});

test("without a bundle startup continues with one line saying where to put one", async () => {
  const data = dataDirectory();
  const lines = logs();
  const started = await session(data, {});
  expect(started[0]).not.toHaveProperty("battleBundle");
  const status = lines.filter((line) => line.startsWith("Battle VM runtime"));
  expect(status).toHaveLength(1);
  expect(status[0]).toContain(join(data, "battle-bundle"));
  expect(status[0]).toContain("build_bundle.py");
});

test("an explicit bundle wins over the default and a missing one stops before any download", async () => {
  const data = dataDirectory();
  mkdirSync(join(data, "battle-bundle"));
  const explicit = dataDirectory();
  const lines = logs();
  const started = await session(data, { battleBundle: explicit });
  expect(started[0]?.battleBundle).toBe(explicit);
  expect(lines).toContain(`Battle VM runtime: ${explicit}`);
  const missing = join(data, "nope");
  await expect(
    session(data, { battleBundle: missing }, async () => {
      throw new Error("must not download");
    }),
  ).rejects.toThrow(`Battle bundle not found: ${missing}`);
});

test("a binary override still reads the default bundle, and options never touch the filesystem", async () => {
  const data = dataDirectory();
  mkdirSync(join(data, "battle-bundle"));
  const started = await session(data, { binary: "/private/native" });
  expect(started[0]?.battleBundle).toBe(join(data, "battle-bundle"));
  const parsed = parseOptions(["--data", "/fixture/does-not-exist"], "/fixture", {});
  expect(parsed.managedSimulator).toEqual({});
});

test("integration scripts and managed startup tests never reach GitHub for a release", () => {
  // Scripts that run make local or parse managed options must name a binary, an external
  // endpoint or --no-simulator, otherwise the real installer would contact GitHub.
  const directory = new URL("../integration/", import.meta.url).pathname;
  for (const name of ["simulator-battle.ts", "simulator-fixture.ts", "simulator-hello.ts"]) {
    const source = readFileSync(join(directory, name), "utf8");
    expect(source).toMatch(/--no-simulator|--simulator-endpoint|simulator-binary/u);
  }
});
