import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  autoInitProblemsSubmodule,
  problemSearchRoots,
} from "../../../scripts/local-play/catalog-loader";
import {
  browserDisplayText,
  buildLocalRuntimeConfig,
} from "../../../scripts/local-play/codespaces-links";
import { codespacesForwardedOrigin } from "../../../scripts/local-play/codespaces-origin";
import {
  composeArgs,
  composeArgsForCli,
  composeFailureMessage,
  generateSecretEnv,
  openPrivateAppendLog,
  resolveComposeCli,
} from "../../../scripts/local-play/docker-adapter";
import {
  ensurePrivateLocalDirectory,
  persistStartedContainerUnit,
  printRunningEndpoints,
  recordedApiIsHealthy,
  requiredLocalApiPort,
  shutdownLocalServe,
  stopPersistedContainerUnit,
  waitForProblemRunning,
  waitForServeProcessExit,
} from "../../../scripts/local-play/local-runtime-support";
import { observeProcessIdentity } from "../../../scripts/local-play/process-identity";
import {
  reclaimStaleSession,
  stopRecordedProcess,
} from "../../../scripts/local-play/session-state";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("shutdownLocalServe", () => {
  it("should quiesce HTTP and in-flight scoring before lifecycle cleanup", async () => {
    const server = deferred();
    const scoring = deferred();
    const events: string[] = [];
    const shutdown = shutdownLocalServe({
      closeServer: () => {
        events.push("server-close-started");
        return server.promise;
      },
      scoringCycle: scoring.promise.then(() => {
        events.push("scoring-settled");
      }),
      stopAll: async () => {
        events.push("lifecycle-stopped");
      },
      closeSimulator: async () => {
        events.push("simulator-closed");
      },
      persistState: async () => {
        events.push("state-persisted");
      },
      closeStateStore: async () => {
        events.push("state-store-closed");
      },
    });

    await Promise.resolve();
    expect(events).toEqual(["server-close-started"]);
    server.resolve();
    await Promise.resolve();
    expect(events).toEqual(["server-close-started"]);
    scoring.resolve();
    await expect(shutdown).resolves.toEqual([]);
    expect(events).toEqual([
      "server-close-started",
      "scoring-settled",
      "state-persisted",
      "lifecycle-stopped",
      "simulator-closed",
      "state-store-closed",
    ]);
  });
});

describe("local-down progress lifecycle", () => {
  it("should clear persisted progress after stopping local play", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-local-down-"));
    const databasePath = join(directory, "local-play.sqlite");
    const fixture = join(import.meta.dirname, "..", "fixtures", "local-play-down.ts");

    try {
      const result = spawnSync("bun", [fixture, directory], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Local play stopped and progress cleared.");
      expect(result.stdout.trim().endsWith("undefined")).toBe(true);
    } finally {
      for (const suffix of ["", "-shm", "-wal"]) {
        const path = `${databasePath}${suffix}`;
        try {
          unlinkSync(path);
        } catch {}
      }
      rmdirSync(directory);
    }
  });
});

describe("detached serve port", () => {
  it("should require the parent-selected API port and reject invalid values", () => {
    expect(requiredLocalApiPort("43199")).toBe(43199);
    expect(() => requiredLocalApiPort(undefined)).toThrow("LOCAL_API_PORT is required");
    expect(() => requiredLocalApiPort("0")).toThrow("between 1 and 65535");
  });
});

describe("local endpoint presentation", () => {
  it("should print only HTTP access URLs returned by the participant projection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        problems: [
          {
            name: "Simulated app",
            lifecycle: { status: "running", runtimeKind: "simulated-cloud" },
            stackOutputs: {
              AppUrl: "http://127.0.0.1:43199/",
              DbEndpoint: "db.example.us-east-1.rds.amazonaws.com",
              InstanceId: "i-local",
            },
          },
        ],
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await printRunningEndpoints("http://127.0.0.1:41000", "participant-token");

      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "Challenge — Simulated app (AppUrl): http://127.0.0.1:43199/",
      );
    } finally {
      log.mockRestore();
      fetchMock.mockRestore();
    }
  });
});

describe("waitForProblemRunning (async 202 start)", () => {
  const lifecycleResponse = (lifecycle: Record<string, unknown> | undefined) =>
    Response.json({ problems: [{ problemId: "p1", ...(lifecycle ? { lifecycle } : {}) }] });

  it("should resolve once the problem's lifecycle reaches running", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(lifecycleResponse({ status: "starting" }))
      .mockResolvedValueOnce(lifecycleResponse({ status: "running" }));
    try {
      await waitForProblemRunning("http://127.0.0.1:41000", "p1", "token", { pollMs: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("should treat a lifecycle-less view (AWS-mode shape) as already playable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(lifecycleResponse(undefined));
    try {
      await waitForProblemRunning("http://127.0.0.1:41000", "p1", "token", { pollMs: 1 });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("should throw with the lifecycle lastError when the async start failed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(lifecycleResponse({ status: "error", lastError: "compose boom" }));
    try {
      await expect(
        waitForProblemRunning("http://127.0.0.1:41000", "p1", "token", { pollMs: 1 }),
      ).rejects.toThrow('problem "p1" failed to start: compose boom');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("should throw on an unreachable poll and on timeout with a build hint", async () => {
    const failing = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    try {
      await expect(
        waitForProblemRunning("http://127.0.0.1:41000", "p1", "token", { pollMs: 1 }),
      ).rejects.toThrow('failed to poll problem "p1" (HTTP 500)');
    } finally {
      failing.mockRestore();
    }

    // 疑似時計を timeout の先へ進め、 "starting" のまま打ち切られる経路を観測する。
    let clock = 0;
    const stuck = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(lifecycleResponse({ status: "starting" })));
    try {
      await expect(
        waitForProblemRunning("http://127.0.0.1:41000", "p1", "token", {
          pollMs: 1,
          timeoutMs: 10,
          now: () => {
            clock += 6;
            return clock;
          },
        }),
      ).rejects.toThrow(/timed out .* toolchain image/);
    } finally {
      stuck.mockRestore();
    }
  });
});

describe("local state permissions", () => {
  it("should repair the local directory and API log to owner-only modes", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-local-permissions-"));
    const logPath = join(directory, "api.log");
    try {
      chmodSync(directory, 0o755);
      ensurePrivateLocalDirectory(directory);
      expect(statSync(directory).mode & 0o777).toBe(0o700);

      const logFd = openPrivateAppendLog(logPath);
      closeSync(logFd);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      unlinkSync(logPath);
      rmdirSync(directory);
    }
  });
});

describe("persisted container ownership", () => {
  it("should retain a new unit when its first durable commit reports an after-rename failure", () => {
    const unit = {
      problemId: "ambiguous-start",
      composePath: "/tmp/ambiguous.compose.yml",
      composeProjectName: "tc-ambiguous-start",
      secretEnv: [],
      remappedComposePath: "/tmp/ambiguous.compose.yml",
    };
    const units = new Map<string, typeof unit>();
    const durableProjection: (typeof unit)[] = [];
    let first = true;
    const persistUnits = vi.fn(() => {
      durableProjection.splice(0, durableProjection.length, ...units.values());
      if (first) {
        first = false;
        throw new Error("directory fsync failed after rename");
      }
    });

    expect(() => persistStartedContainerUnit(units, persistUnits, unit)).toThrow(
      "Problem container start failed and cleanup was incomplete",
    );
    expect(persistUnits).toHaveBeenCalledTimes(2);
    expect(units.get(unit.problemId)).toBe(unit);
    expect(durableProjection).toEqual([unit]);
  });

  it("should keep the compose handle until ownership release persists and allow Stop retry", () => {
    const unit = {
      problemId: "retry-cleanup",
      composePath: "/tmp/retry.compose.yml",
      composeProjectName: "tc-retry-cleanup",
      secretEnv: [],
      remappedComposePath: "/tmp/retry.compose.yml",
    };
    const units = new Map([[unit.problemId, unit]]);
    const runner = {
      stopPhysical: vi.fn(),
      finalizeStop: vi.fn(),
    };
    let failPersist = true;
    const persistUnits = vi.fn(() => {
      if (failPersist) {
        failPersist = false;
        throw new Error("units persistence failed");
      }
    });

    expect(() => stopPersistedContainerUnit(runner, units, persistUnits, unit)).toThrow(
      "units persistence failed",
    );
    expect(units.get(unit.problemId)).toBe(unit);
    expect(runner.stopPhysical).toHaveBeenCalledTimes(1);
    expect(runner.finalizeStop).not.toHaveBeenCalled();

    expect(() => stopPersistedContainerUnit(runner, units, persistUnits, unit)).not.toThrow();
    expect(units.has(unit.problemId)).toBe(false);
    expect(runner.stopPhysical).toHaveBeenCalledTimes(2);
    expect(runner.finalizeStop).toHaveBeenCalledWith(unit);
  });
});

describe("recorded serve process identity", () => {
  it("should treat a reused PID as the recorded process already being gone", () => {
    const identity = observeProcessIdentity(process.pid);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    const kill = vi.spyOn(process, "kill");
    expect(() => stopRecordedProcess(process.pid, undefined, "Local-play serve")).not.toThrow();
    expect(() =>
      stopRecordedProcess(process.pid, "0".repeat(64), "Local-play serve"),
    ).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("should reject foreign health without probing a reused serve port", async () => {
    const health = vi.fn(async () => true);
    await expect(
      recordedApiIsHealthy(
        {
          pid: 42_123,
          processIdentity: "a".repeat(64),
          apiBaseUrl: "http://127.0.0.1:3199",
          problemIds: [],
          deploymentPath: "/repo/deployment.json",
          runtimeConfigPath: "/repo/runtime-config.json",
          participantToken: "a".repeat(43),
        },
        () => "b".repeat(64),
        health,
      ),
    ).resolves.toBe(false);
    expect(health).not.toHaveBeenCalled();
  });

  it("should treat ESRCH after identity observation as an idempotent exit race", () => {
    const identity = observeProcessIdentity(process.pid);
    if (!identity) throw new Error("test process identity is unavailable");
    const noSuchProcess = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw noSuchProcess;
    });

    expect(() => stopRecordedProcess(process.pid, identity, "Local-play serve")).not.toThrow();
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    kill.mockRestore();
  });

  it("should treat PID reuse during exit waiting as the recorded process exiting", async () => {
    const observed = ["recorded-identity", "replacement-identity"];
    const observe = vi.fn(() => observed.shift() ?? "replacement-identity");

    await expect(
      waitForServeProcessExit(42_123, "recorded-identity", 1_000, observe, async () => {}),
    ).resolves.toBe(true);
    expect(observe).toHaveBeenCalledTimes(2);
  });
});

describe("autoInitProblemsSubmodule", () => {
  it("should check out the problems/ submodule when it is registered (fresh clone / Codespace)", () => {
    const run = vi.fn(() => true);
    const initialized = autoInitProblemsSubmodule("/repo", run, (p) => p === "/repo/.gitmodules");
    expect(initialized).toBe(true);
    expect(run).toHaveBeenCalledWith("git", ["submodule", "update", "--init", "problems"]);
  });

  it("should do nothing when no submodule is registered (e.g. a source tarball)", () => {
    const run = vi.fn(() => true);
    expect(autoInitProblemsSubmodule("/repo", run, () => false)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("should report failure so callers fall back to the manual instruction", () => {
    expect(
      autoInitProblemsSubmodule(
        "/repo",
        () => false,
        () => true,
      ),
    ).toBe(false);
  });
});

describe("problemSearchRoots", () => {
  it("should search only the catalog groups (problems live in the catalog, not the platform)", () => {
    expect(problemSearchRoots("/repo")).toEqual([
      "/repo/problems/challenges",
      "/repo/problems/battles",
    ]);
  });
});

describe("generateSecretEnv", () => {
  it("should mint one fresh secret per declared env name", () => {
    let n = 0;
    const env = generateSecretEnv(["FLAG_SEED", "ADMIN_TOKEN"], () => `secret-${n++}`);
    expect(env).toEqual({ FLAG_SEED: "secret-0", ADMIN_TOKEN: "secret-1" });
  });

  it("should return an empty object when no secrets are declared", () => {
    expect(generateSecretEnv([])).toEqual({});
  });

  it("should default to a 256-bit hex secret", () => {
    const env = generateSecretEnv(["FLAG_SEED"]);
    expect(env.FLAG_SEED).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("composeArgs", () => {
  it("should build a detached `up` invocation", () => {
    expect(composeArgs("/p/local/docker-compose.yml", "tc-local-sqli-demo", "up")).toEqual([
      "compose",
      "-f",
      "/p/local/docker-compose.yml",
      "-p",
      "tc-local-sqli-demo",
      "up",
      "-d",
      "--build",
    ]);
  });

  it("should build a volume-pruning `down` invocation", () => {
    expect(composeArgs("/p/local/docker-compose.yml", "tc-local-sqli-demo", "down")).toEqual([
      "compose",
      "-f",
      "/p/local/docker-compose.yml",
      "-p",
      "tc-local-sqli-demo",
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
  });

  it("should pin --project-directory when a port-remapped copy runs (#2392)", () => {
    expect(composeArgs("/tmp/tc-local-b.compose.yml", "tc-local-b", "up", "/p/b/local")).toEqual([
      "compose",
      "-f",
      "/tmp/tc-local-b.compose.yml",
      "-p",
      "tc-local-b",
      "--project-directory",
      "/p/b/local",
      "up",
      "-d",
      "--build",
    ]);
  });
});

describe("composeArgsForCli", () => {
  it("should keep the compose subcommand for the Docker CLI plugin", () => {
    expect(
      composeArgsForCli(
        { command: "docker", prefix: ["compose"], label: "docker compose" },
        "/p/local/docker-compose.yml",
        "tc-local-sqli-demo",
        "up",
      ),
    ).toEqual([
      "compose",
      "-f",
      "/p/local/docker-compose.yml",
      "-p",
      "tc-local-sqli-demo",
      "up",
      "-d",
      "--build",
    ]);
  });

  it("should omit the compose subcommand for standalone docker-compose", () => {
    expect(
      composeArgsForCli(
        { command: "docker-compose", prefix: [], label: "docker-compose" },
        "/p/local/docker-compose.yml",
        "tc-local-sqli-demo",
        "down",
      ),
    ).toEqual([
      "-f",
      "/p/local/docker-compose.yml",
      "-p",
      "tc-local-sqli-demo",
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
  });
});

describe("resolveComposeCli", () => {
  it("should prefer docker compose when both compose frontends are available", () => {
    const cli = resolveComposeCli({}, (command, args) => {
      return (
        (command === "docker" && args.join(" ") === "compose version") ||
        (command === "docker-compose" && args.join(" ") === "version")
      );
    });
    expect(cli).toMatchObject({ command: "docker", prefix: ["compose"], label: "docker compose" });
  });

  it("should fall back to standalone docker-compose when the docker plugin is unavailable", () => {
    const cli = resolveComposeCli({}, (command) => command === "docker-compose");
    expect(cli).toMatchObject({ command: "docker-compose", prefix: [], label: "docker-compose" });
  });

  it("should allow forcing standalone docker-compose", () => {
    const cli = resolveComposeCli({ TENKACLOUD_COMPOSE_CLI: "docker-compose" }, (command) => {
      return command === "docker-compose";
    });
    expect(cli).toMatchObject({ command: "docker-compose", prefix: [], label: "docker-compose" });
  });

  it("should fail loudly when the requested compose frontend is unavailable", () => {
    expect(() =>
      resolveComposeCli({ TENKACLOUD_COMPOSE_CLI: "docker-compose" }, () => false),
    ).toThrow(/docker-compose was requested/);
  });
});

describe("composeFailureMessage", () => {
  const commandLine = "docker-compose -f /p/local/docker-compose.yml -p tc-local-a up -d";

  it("should include the stderr tail so the portal error carries the cause", () => {
    const message = composeFailureMessage(
      commandLine,
      "Pulling web ...\nBind for 0.0.0.0:18080 failed: port is already allocated\n",
    );
    expect(message).toContain(`${commandLine} failed`);
    expect(message).toContain("port is already allocated");
  });

  it("should keep the bare failure line when stderr is empty", () => {
    expect(composeFailureMessage(commandLine, "")).toBe(`${commandLine} failed`);
  });

  it("should cap the carried stderr to its last 20 lines", () => {
    const stderr = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n");
    const message = composeFailureMessage(commandLine, stderr);
    expect(message).not.toContain("line-10\n");
    expect(message).toContain("line-11");
    expect(message).toContain("line-30");
  });

  it("should append a start-the-daemon hint when the Docker daemon is unreachable", () => {
    const message = composeFailureMessage(
      commandLine,
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
    expect(message).toContain("The Docker daemon looks unreachable");
    expect(message).toContain("colima start");
  });

  it("should recognize the compose v2 daemon-connect failure shape", () => {
    const message = composeFailureMessage(
      commandLine,
      'error during connect: Get "http://.../v1.24/containers/json": dial unix /Users/x/.colima/default/docker.sock: connect: no such file or directory',
    );
    expect(message).toContain("The Docker daemon looks unreachable");
  });

  it("should not add the daemon hint for an ordinary compose failure", () => {
    const message = composeFailureMessage(
      commandLine,
      'service "web" has neither an image nor a build context',
    );
    expect(message).not.toContain("The Docker daemon looks unreachable");
  });
});

describe("buildLocalRuntimeConfig", () => {
  it("should wire the portal to the loopback scoring API in local backend mode", () => {
    const config = buildLocalRuntimeConfig("http://127.0.0.1:3199", "local-session-token");
    expect(config).toMatchObject({
      apiBaseUrl: "http://127.0.0.1:3199",
      mode: "backend",
      cloudMode: "local",
      eventRegion: "local",
      localTeamLoginKey: "local-session-token",
    });
  });

  it("should use the fixed Codespaces portal API bridge for browser runtime config", () => {
    const config = buildLocalRuntimeConfig("http://127.0.0.1:3199", "codespaces-session-token", {
      CODESPACE_NAME: "tenkacloud-demo",
      GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
    });

    expect(config).toMatchObject({
      apiBaseUrl: "https://tenkacloud-demo-5175.app.github.dev/__tenkacloud-local-api",
      mode: "backend",
      cloudMode: "local",
      localTeamLoginKey: "codespaces-session-token",
    });
  });

  it("should reject poisoned Codespaces names and forwarding domains", () => {
    for (const env of [
      {
        CODESPACE_NAME: "demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "evil.com@attacker.example",
      },
      {
        CODESPACE_NAME: "demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev:8443",
      },
      {
        CODESPACE_NAME: "demo/path",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
      },
      {
        CODESPACE_NAME: "demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "https://app.github.dev/path",
      },
    ]) {
      expect(codespacesForwardedOrigin(3199, env)).toBeUndefined();
      expect(buildLocalRuntimeConfig("http://127.0.0.1:3199", "session", env).apiBaseUrl).toBe(
        "http://127.0.0.1:3199",
      );
    }
  });

  it("should reject a forwarded hostname whose combined first DNS label exceeds 63 bytes", () => {
    const domain = "app.github.dev";
    expect(
      codespacesForwardedOrigin(3199, {
        CODESPACE_NAME: "a".repeat(58),
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain,
      }),
    ).toBe(`https://${"a".repeat(58)}-3199.${domain}`);
    expect(
      codespacesForwardedOrigin(3199, {
        CODESPACE_NAME: "a".repeat(59),
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain,
      }),
    ).toBeUndefined();
  });
});

describe("reclaimStaleSession", () => {
  const state = { apiBaseUrl: "http://127.0.0.1:3199", pid: 12345 };

  it("should do nothing when no session state exists", async () => {
    const probe = vi.fn(async () => true);
    const release = vi.fn();
    await reclaimStaleSession(
      "/repo/.tenkacloud/local/state.json",
      () => state,
      probe,
      release,
      () => false,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("should keep refusing a double start while the recorded API is alive", async () => {
    const release = vi.fn();
    await expect(
      reclaimStaleSession(
        "/repo/.tenkacloud/local/state.json",
        () => state,
        async () => true,
        release,
        () => true,
      ),
    ).rejects.toThrow(/already running/);
    expect(release).not.toHaveBeenCalled();
  });

  it("should reclaim a stale session (Codespace suspend / reboot) so the start proceeds", async () => {
    const release = vi.fn();
    await reclaimStaleSession(
      "/repo/.tenkacloud/local/state.json",
      () => state,
      async () => false,
      release,
      () => true,
    );
    expect(release).toHaveBeenCalledWith(state);
  });
});

describe("browserDisplayText", () => {
  it("should rewrite loopback URLs to isolated Codespaces port origins", () => {
    expect(
      browserDisplayText("Open http://127.0.0.1:18180/admin and http://localhost:18280/healthz.", {
        CODESPACE_NAME: "tenkacloud-demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
      }),
    ).toBe(
      "Open https://tenkacloud-demo-18180.app.github.dev/admin and https://tenkacloud-demo-18280.app.github.dev/healthz.",
    );
  });

  it("should preserve path, query, and fragment when rewriting Codespaces URLs", () => {
    expect(
      browserDisplayText("Open http://127.0.0.1:18180/search?q=flag#top", {
        CODESPACE_NAME: "tenkacloud-demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "https://app.github.dev/",
      }),
    ).toBe("Open https://tenkacloud-demo-18180.app.github.dev/search?q=flag#top");
  });

  it("should leave loopback URLs unchanged outside Codespaces", () => {
    expect(browserDisplayText("Open http://127.0.0.1:18180/admin.", {})).toBe(
      "Open http://127.0.0.1:18180/admin.",
    );
  });

  it("should keep arbitrary challenge ports off the portal origin and expose only the API bridge", () => {
    const viteConfig = readFileSync(
      resolve(import.meta.dirname, "..", "..", "..", "apps/participant-portal/vite.config.ts"),
      "utf8",
    );
    expect(viteConfig).not.toContain("__tenkacloud-local-port");
    expect(viteConfig).toContain("createLocalApiProxyMiddleware");
    expect(viteConfig).toContain("strictPort: true");
    expect(viteConfig).toContain("cors: false");
  });
});
