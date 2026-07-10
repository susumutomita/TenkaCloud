import { describe, expect, it, vi } from "vitest";
import {
  autoInitProblemsSubmodule,
  browserDisplayText,
  buildLocalRuntimeConfig,
  composeArgs,
  composeArgsForCli,
  composeFailureMessage,
  generateSecretEnv,
  problemSearchRoots,
  reclaimStaleSession,
  resolveComposeCli,
} from "../../../scripts/tenkacloud-local";

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
    const config = buildLocalRuntimeConfig("http://127.0.0.1:3199");
    expect(config).toMatchObject({
      apiBaseUrl: "http://127.0.0.1:3199",
      mode: "backend",
      cloudMode: "local",
      eventRegion: "local",
    });
  });

  it("should use the Codespaces portal-origin API proxy for the browser runtime config", () => {
    const config = buildLocalRuntimeConfig("http://127.0.0.1:3199", {
      CODESPACE_NAME: "tenkacloud-demo",
      GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
    });

    expect(config).toMatchObject({
      apiBaseUrl: "https://tenkacloud-demo-5175.app.github.dev/__tenkacloud-local-api",
      mode: "backend",
      cloudMode: "local",
    });
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
  it("should rewrite loopback challenge URLs to the Codespaces portal proxy", () => {
    expect(
      browserDisplayText("Open http://127.0.0.1:18180/admin and http://localhost:18280/healthz.", {
        CODESPACE_NAME: "tenkacloud-demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
      }),
    ).toBe(
      "Open https://tenkacloud-demo-5175.app.github.dev/__tenkacloud-local-port/18180/admin and https://tenkacloud-demo-5175.app.github.dev/__tenkacloud-local-port/18280/healthz.",
    );
  });

  it("should preserve path, query, and fragment when rewriting Codespaces URLs", () => {
    expect(
      browserDisplayText("Open http://127.0.0.1:18180/search?q=flag#top", {
        CODESPACE_NAME: "tenkacloud-demo",
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "https://app.github.dev/",
      }),
    ).toBe(
      "Open https://tenkacloud-demo-5175.app.github.dev/__tenkacloud-local-port/18180/search?q=flag#top",
    );
  });

  it("should leave loopback URLs unchanged outside Codespaces", () => {
    expect(browserDisplayText("Open http://127.0.0.1:18180/admin.", {})).toBe(
      "Open http://127.0.0.1:18180/admin.",
    );
  });
});
