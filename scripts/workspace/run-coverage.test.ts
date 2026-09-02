import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COVERAGE_PARTS,
  COVERAGE_WORKSPACES,
  coverageMatrixLegs,
  formatDuration,
  lcovPathForWorkspace,
  parseArgs,
  parseShardPart,
  resolveLcovPaths,
  resolveWorkspaces,
  SHARD_NAMES,
  SHARDS,
  UsageError,
  validateShardParts,
  validateWorkspaces,
  vitestPartArgs,
} from "./run-coverage.ts";

const root = join(import.meta.dir, "../..");

// Issue #2513 / #2756 / #2951 / #3036: hardcode the expected set so an accidental drop from the
// 21-workspace chain (e.g. someone forgetting to port a workspace when editing this file) fails
// loudly instead of silently shrinking the coverage matrix.
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
  "apps/developer-portal",
  "packages/tcloud",
  "packages/ai-eval",
  "packages/security-harness",
];

describe("COVERAGE_WORKSPACES", () => {
  it("should match the 21 workspaces currently in the coverage matrix", () => {
    expect(COVERAGE_WORKSPACES.map((ws) => ws.dir)).toEqual(EXPECTED_DIRS);
  });

  // Issue #2756: developer-portal has a working vitest.config.ts and 18 test files but its
  // tests never ran in CI. It now runs in the packages shard, the app exception to the
  // "packages shard = packages/*" pattern.
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

  // The three SPAs used to share one `spas` leg, which is paced by its slowest member:
  // application-admin-console is ~4.7x admin-console, so the leg finished when the big one did
  // and the small ones' runners sat idle. Each heavy SPA now owns a shard it can be split within.
  it("should give each heavy SPA its own shard", () => {
    expect(SHARDS["app-admin"]).toEqual(["apps/application-admin-console"]);
    expect(SHARDS.portal).toEqual(["apps/participant-portal"]);
    expect(SHARDS.admin).toEqual(["apps/admin-console"]);
  });

  it("should assign every remaining package + developer-portal to the packages shard", () => {
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
      "apps/developer-portal",
      "packages/tcloud",
      "packages/ai-eval",
      "packages/security-harness",
    ]);
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
      "./apps/developer-portal/coverage/lcov.info",
      "./packages/tcloud/coverage/lcov.info",
      "./packages/ai-eval/coverage/lcov.info",
      "./packages/security-harness/coverage/lcov.info",
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
  // Codecov must wait for every coverage upload before it evaluates status, otherwise a
  // partial upload (e.g. the infrastructure shard alone at ~92.11%) leaks out as a false
  // `codecov/project` failure. One upload happens per MATRIX LEG, and a shard split into parts
  // is several legs — so `after_n_builds` tracks the leg count, not the shard count. Splitting a
  // shard without bumping codecov.yml would resurrect the false-failure window this pins shut.
  const codecovPath = join(root, "codecov.yml");

  it("should exist at the repo root", () => {
    expect(existsSync(codecovPath)).toBe(true);
  });

  it("should set every after_n_builds to the matrix leg count so status waits for all uploads", () => {
    const values = [
      ...readFileSync(codecovPath, "utf8").matchAll(/^[ \t]*after_n_builds:[ \t]*(\d+)/gm),
    ].map((m) => Number(m[1]));
    expect(values.length).toBeGreaterThan(0);
    for (const n of values) {
      expect(n).toBe(coverageMatrixLegs().length);
    }
  });
});

describe("COVERAGE_PARTS / coverageMatrixLegs", () => {
  it("should declare a part count for every shard", () => {
    expect(Object.keys(COVERAGE_PARTS).sort()).toEqual([...SHARD_NAMES].sort());
  });

  it("should expand each shard into one leg per part", () => {
    const legs = coverageMatrixLegs();
    expect(legs.length).toBe(SHARD_NAMES.reduce((sum, s) => sum + COVERAGE_PARTS[s], 0));
    for (const shard of SHARD_NAMES) {
      const own = legs.filter((leg) => leg.shard === shard);
      expect(own.map((leg) => leg.part)).toEqual(
        Array.from({ length: COVERAGE_PARTS[shard] }, (_unused, i) => i + 1),
      );
      expect(own.every((leg) => leg.parts === COVERAGE_PARTS[shard])).toBe(true);
    }
  });

  it("should only split shards that hold exactly one workspace", () => {
    expect(() => validateShardParts(COVERAGE_WORKSPACES)).not.toThrow();
    for (const shard of SHARD_NAMES) {
      if (COVERAGE_PARTS[shard] > 1) {
        expect(SHARDS[shard].length).toBe(1);
      }
    }
  });

  it("should reject a split shard that holds more than one workspace", () => {
    const split = SHARD_NAMES.find((shard) => COVERAGE_PARTS[shard] > 1) ?? "infrastructure";
    expect(COVERAGE_PARTS[split]).toBeGreaterThan(1);
    const smuggled = [
      ...COVERAGE_WORKSPACES,
      { dir: "packages/format", filter: "@tenkacloud/format", shard: split },
    ];
    expect(() => validateShardParts(smuggled)).toThrow(/holds 2 workspaces/);
  });
});

describe("ci.yml coverage matrix", () => {
  // The workflow cannot compute its own matrix without an extra dependent job in front of the
  // whole run (a "setup" leg every other leg waits on), so the legs are written out in ci.yml and
  // pinned here instead. A shard split into more parts without editing the workflow would quietly
  // run only some of the parts — the tests in the unlisted slices would simply never execute.
  const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

  it("should list exactly the legs coverageMatrixLegs() declares", () => {
    const legs = [
      ...workflow.matchAll(/^[ \t]*- \{ shard: ([\w-]+), part: (\d+), parts: (\d+) \}[ \t]*$/gm),
    ].map((match) => `${match[1]} ${match[2]}/${match[3]}`);
    const expected = coverageMatrixLegs().map((leg) => `${leg.shard} ${leg.part}/${leg.parts}`);
    expect(legs).toEqual(expected);
  });
});

describe("parseShardPart / vitestPartArgs", () => {
  it("should read <index>/<total>", () => {
    expect(parseShardPart("2/6")).toEqual({ index: 2, total: 6 });
    expect(parseShardPart("1/1")).toEqual({ index: 1, total: 1 });
  });

  it("should reject a malformed, zero, or out-of-range part", () => {
    expect(() => parseShardPart(undefined)).toThrow(UsageError);
    expect(() => parseShardPart("2")).toThrow(UsageError);
    expect(() => parseShardPart("0/6")).toThrow(UsageError);
    expect(() => parseShardPart("7/6")).toThrow(UsageError);
    expect(() => parseShardPart("a/b")).toThrow(UsageError);
  });

  // Vitest validates --shard against the resolved file count, so `--shard=1/1` on a
  // single-file workspace is an error rather than a no-op. An unsplit leg passes nothing.
  it("should pass no Vitest flag for an unsplit run", () => {
    expect(vitestPartArgs(undefined)).toEqual([]);
    expect(vitestPartArgs({ index: 1, total: 1 })).toEqual([]);
    expect(vitestPartArgs({ index: 3, total: 6 })).toEqual(["--shard=3/6"]);
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
