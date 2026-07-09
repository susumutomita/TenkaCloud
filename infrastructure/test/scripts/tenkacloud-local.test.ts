import { describe, expect, it } from "vitest";
import {
  browserDisplayText,
  buildLocalRuntimeConfig,
  composeArgs,
  composeArgsForCli,
  generateSecretEnv,
  problemSearchRoots,
} from "../../../scripts/tenkacloud-local";

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
  it("should rewrite loopback challenge URLs to Codespaces forwarded URLs", () => {
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
});
