import { describe, expect, it } from "vitest";
import {
  buildLocalRuntimeConfig,
  composeArgs,
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
  it("should build a loopback-only `up --wait` invocation", () => {
    expect(composeArgs("/p/local/docker-compose.yml", "tc-local-sqli-demo", "up")).toEqual([
      "compose",
      "-f",
      "/p/local/docker-compose.yml",
      "-p",
      "tc-local-sqli-demo",
      "up",
      "-d",
      "--wait",
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
});
