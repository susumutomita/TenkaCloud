import { describe, expect, it, vi } from "vitest";
import {
  autoInitProblemsSubmodule,
  browserDisplayText,
  buildLocalRuntimeConfig,
  composeArgs,
  composeArgsForCli,
  generateSecretEnv,
  problemSearchRoots,
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
