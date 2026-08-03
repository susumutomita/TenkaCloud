import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATED_WORKSPACES,
  REPORTED_WORKSPACES,
} from "../../.claude/skills/quality-gates/scripts/check-coverage-gate.ts";
import {
  COVERAGE_WORKSPACES,
  formatDuration,
  lcovPathForWorkspace,
  parseArgs,
  resolveLcovPaths,
  resolveWorkspaces,
  SHARD_NAMES,
  SHARDS,
  UsageError,
  validateWorkspaces,
} from "./run-coverage.ts";

const root = join(import.meta.dir, "../..");

// Issue #2513 / #2756: hardcode the expected set so an accidental drop from the 18-workspace
// chain (e.g. someone forgetting to port a workspace when editing this file) fails loudly
// instead of silently shrinking the coverage matrix.
const EXPECTED_DIRS = [
  "infrastructure",
  "apps/admin-console",
  "apps/application-admin-console",
  "apps/participant-portal",
  "packages/trust-bridge",
  "packages/auth-client",
  "packages/saml-utils",
  "packages/problem-cost",
  "packages/problem-runtime",
  "packages/problem-sdk",
  "packages/format",
  "packages/coordination-plugin-sdk",
  "packages/portal-contracts",
  "packages/web-kit",
  "packages/portal-plugin-sdk",
  "packages/problem-test-harness",
  "apps/always-on-control-plane",
  "apps/developer-portal",
];

describe("COVERAGE_WORKSPACES", () => {
  it("should match the 18 workspaces currently in the coverage matrix", () => {
    expect(COVERAGE_WORKSPACES.map((ws) => ws.dir)).toEqual(EXPECTED_DIRS);
  });

  // Issue #2756: developer-portal has a working vitest.config.ts and 18 test files but its
  // tests never ran in CI. It now runs in the packages shard alongside its fellow app
  // apps/always-on-control-plane, which already broke the "packages shard = packages/*" pattern.
  it("should include developer-portal in the packages shard now that its tests run in CI", () => {
    const ws = COVERAGE_WORKSPACES.find((w) => w.dir === "apps/developer-portal");
    expect(ws?.shard).toBe("packages");
  });

  it("should point every workspace at a dir that exists and a filter matching package.json name", () => {
    for (const ws of COVERAGE_WORKSPACES) {
      const dirPath = join(root, ws.dir);
      expect(existsSync(dirPath)).toBe(true);
      const pkg = JSON.parse(readFileSync(join(dirPath, "package.json"), "utf8")) as {
        name: string;
      };
      expect(pkg.name).toBe(ws.filter);
    }
  });
});

describe("SHARDS", () => {
  it("should partition COVERAGE_WORKSPACES exactly, with no duplicates and no empty shard", () => {
    const allShardDirs = SHARD_NAMES.flatMap((shard) => SHARDS[shard]);
    expect(new Set(allShardDirs).size).toBe(allShardDirs.length);
    expect([...allShardDirs].sort()).toEqual(COVERAGE_WORKSPACES.map((ws) => ws.dir).sort());
    for (const shard of SHARD_NAMES) {
      expect(SHARDS[shard].length).toBeGreaterThan(0);
    }
  });

  it("should assign only infrastructure to the infrastructure shard", () => {
    expect(SHARDS.infrastructure).toEqual(["infrastructure"]);
  });

  it("should assign exactly the 3 SPAs to the spas shard", () => {
    expect(SHARDS.spas).toEqual([
      "apps/admin-console",
      "apps/application-admin-console",
      "apps/participant-portal",
    ]);
  });

  it("should assign every remaining package + always-on-control-plane + developer-portal to the packages shard", () => {
    expect(SHARDS.packages).toEqual([
      "packages/trust-bridge",
      "packages/auth-client",
      "packages/saml-utils",
      "packages/problem-cost",
      "packages/problem-runtime",
      "packages/problem-sdk",
      "packages/format",
      "packages/coordination-plugin-sdk",
      "packages/portal-contracts",
      "packages/web-kit",
      "packages/portal-plugin-sdk",
      "packages/problem-test-harness",
      "apps/always-on-control-plane",
      "apps/developer-portal",
    ]);
  });

  it("should cover every workspace the coverage gate reads, so per-shard gating covers the full gated set", () => {
    const covered = new Set(COVERAGE_WORKSPACES.map((ws) => ws.dir));
    for (const ws of [...GATED_WORKSPACES, ...REPORTED_WORKSPACES]) {
      expect(covered.has(ws)).toBe(true);
    }
  });
});

describe("validateWorkspaces", () => {
  it("should not throw for the real COVERAGE_WORKSPACES set", () => {
    expect(() => validateWorkspaces(COVERAGE_WORKSPACES)).not.toThrow();
  });

  it("should throw loudly on a duplicate workspace dir", () => {
    const withDuplicate = [...COVERAGE_WORKSPACES, COVERAGE_WORKSPACES[0]];
    expect(() => validateWorkspaces(withDuplicate)).toThrow();
  });

  it("should throw loudly on a workspace dir that does not exist on disk", () => {
    const bogus = [
      { dir: "does/not/exist", filter: "@tenkacloud/nope", shard: "packages" as const },
    ];
    expect(() => validateWorkspaces(bogus)).toThrow();
  });

  it("should throw loudly on an unknown shard name", () => {
    const bogus = [
      { dir: "infrastructure", filter: "@TenkaCloud/infrastructure", shard: "bogus" as never },
    ];
    expect(() => validateWorkspaces(bogus)).toThrow();
  });
});

describe("parseArgs", () => {
  it("should select every workspace when called with no arguments", () => {
    expect(parseArgs([])).toEqual({ shard: undefined, printLcovPaths: false });
  });

  it("should select the requested shard for --shard packages", () => {
    expect(parseArgs(["--shard", "packages"])).toEqual({
      shard: "packages",
      printLcovPaths: false,
    });
  });

  it("should allow printing lcov paths for a shard without running tests", () => {
    expect(parseArgs(["--shard", "packages", "--print-lcov-paths"])).toEqual({
      shard: "packages",
      printLcovPaths: true,
    });
  });

  it("should reject an unknown shard name", () => {
    expect(() => parseArgs(["--shard", "nope"])).toThrow(UsageError);
  });

  it("should reject an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(UsageError);
  });
});

describe("resolveLcovPaths", () => {
  it("should derive every Codecov upload path from COVERAGE_WORKSPACES", () => {
    expect(resolveLcovPaths(undefined)).toEqual(COVERAGE_WORKSPACES.map(lcovPathForWorkspace));
  });

  it("should derive the packages shard upload list instead of relying on a hand-written CI list", () => {
    expect(resolveLcovPaths("packages")).toEqual([
      "./packages/trust-bridge/coverage/lcov.info",
      "./packages/auth-client/coverage/lcov.info",
      "./packages/saml-utils/coverage/lcov.info",
      "./packages/problem-cost/coverage/lcov.info",
      "./packages/problem-runtime/coverage/lcov.info",
      "./packages/problem-sdk/coverage/lcov.info",
      "./packages/format/coverage/lcov.info",
      "./packages/coordination-plugin-sdk/coverage/lcov.info",
      "./packages/portal-contracts/coverage/lcov.info",
      "./packages/web-kit/coverage/lcov.info",
      "./packages/portal-plugin-sdk/coverage/lcov.info",
      "./packages/problem-test-harness/coverage/lcov.info",
      "./apps/always-on-control-plane/coverage/lcov.info",
      "./apps/developer-portal/coverage/lcov.info",
    ]);
  });
});

describe("resolveWorkspaces", () => {
  it("should return every workspace, in order, when no shard is given", () => {
    expect(resolveWorkspaces(undefined)).toEqual(COVERAGE_WORKSPACES);
  });

  it("should return only the requested shard's workspaces, in order", () => {
    const dirs = resolveWorkspaces("packages").map((ws) => ws.dir);
    expect(dirs).toEqual(SHARDS.packages);
  });
});

describe("codecov.yml (Issue #2666)", () => {
  // Codecov must wait for every coverage shard before it evaluates status, otherwise a
  // partial upload (e.g. the infrastructure shard alone at ~92.11%) leaks out as a false
  // `codecov/project` failure. `after_n_builds` encodes the shard count, so it must track
  // SHARD_NAMES; this test fails loudly if the two drift (a 4th shard added without bumping
  // codecov.yml, or vice versa).
  const codecovPath = join(root, "codecov.yml");

  it("should exist at the repo root", () => {
    expect(existsSync(codecovPath)).toBe(true);
  });

  it("should set every after_n_builds to the shard count so status waits for all shards", () => {
    const values = [
      ...readFileSync(codecovPath, "utf8").matchAll(/^[ \t]*after_n_builds:[ \t]*(\d+)/gm),
    ].map((m) => Number(m[1]));
    expect(values.length).toBeGreaterThan(0);
    for (const n of values) {
      expect(n).toBe(SHARD_NAMES.length);
    }
  });
});

describe("formatDuration", () => {
  it("should format sub-minute durations as seconds with one decimal place", () => {
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(59_900)).toBe("59.9s");
    expect(formatDuration(0)).toBe("0.0s");
  });

  it("should format minute-plus durations as minutes and seconds", () => {
    expect(formatDuration(65_000)).toBe("1m5.0s");
    expect(formatDuration(125_400)).toBe("2m5.4s");
  });
});
