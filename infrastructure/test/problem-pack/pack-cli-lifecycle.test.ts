/**
 * [Problem Packs / Issue #2094] Tests for the `pack install|list|inspect|remove`
 * subcommands on the SAME offline CLI dispatcher that `pack validate` (#2088) and
 * `pack init` (#2089) use.
 *
 * The CLI stays a pure function over (args, lineSink) returning an exit code, so
 * the suite is deterministic and offline — no process spawn, no network, no cloud.
 * Exit-code contract (shared with validate/init): 0 success, 1 lifecycle refusal
 * (invalid pack / digest conflict / compose conflict / pinned removal), 2 tool
 * failure (bad usage / missing args).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackCli } from "../../lib/problem-pack/pack-cli";

let base: string;
let packDir: string;
let storeDir: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-cli-lifecycle-"));
  packDir = path.join(base, "pack");
  storeDir = path.join(base, "store");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "com.example.cloud-pack",
    version: "1.2.3",
    core: "^1.0.0",
    title: "Example Cloud Pack",
    description: "A sample pack of cloud problems.",
    license: "Apache-2.0",
    problemsRoot: "problems",
    requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
    ...overrides,
  };
}

function writeValidPack(
  dir: string,
  options: { manifestOverrides?: Record<string, unknown>; problemId?: string } = {},
): void {
  const problemId = options.problemId ?? "hello-world";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tenkacloud-pack.json"),
    JSON.stringify(manifest(options.manifestOverrides), null, 2),
  );
  const problemDir = path.join(dir, "problems", "challenges", problemId);
  fs.mkdirSync(problemDir, { recursive: true });
  fs.writeFileSync(
    path.join(problemDir, "metadata.json"),
    JSON.stringify({
      id: problemId,
      title: problemId,
      category: "challenges",
      cfnTemplate: "template.yaml",
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    }),
  );
  fs.writeFileSync(path.join(problemDir, "template.yaml"), "Resources: {}\n");
}

function run(args: readonly string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = runPackCli(args, (line) => lines.push(line));
  return { code, out: lines.join("\n") };
}

const STORE = () => ["--store", storeDir];

describe("runPackCli install (#2094)", () => {
  it("should exit 0 and print pack id, version, digest, source kind, and problem count", () => {
    writeValidPack(packDir);

    const { code, out } = run(["install", packDir, ...STORE()]);

    expect(code).toBe(0);
    expect(out).toContain("com.example.cloud-pack");
    expect(out).toContain("1.2.3");
    expect(out).toContain("local");
    expect(out).toMatch(/[0-9a-f]{64}/);
    expect(out).toContain("1"); // problem count
  });

  it("should be idempotent: a second identical install exits 0 and reports already installed", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);

    const { code, out } = run(["install", packDir, ...STORE()]);

    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("already");
  });

  it("should exit 1 on a same id+version, different-digest conflict", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);
    fs.writeFileSync(
      path.join(packDir, "problems", "challenges", "hello-world", "template.yaml"),
      "Resources: { Changed: true }\n",
    );

    const { code, out } = run(["install", packDir, ...STORE()]);

    expect(code).toBe(1);
    expect(out.toLowerCase()).toContain("digest");
  });

  it("should exit 1 and leave no residue when the pack is invalid", () => {
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, "stray.txt"), "not a pack\n");

    const { code } = run(["install", packDir, ...STORE()]);

    expect(code).toBe(1);
    expect(fs.existsSync(path.join(storeDir, "packs-lock.json"))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, "snapshots"))).toBe(false);
  });

  it("should exit 2 when install has no directory argument", () => {
    const { code, out } = run(["install", ...STORE()]);

    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });

  it("should exit 2 when --store is given with no value", () => {
    writeValidPack(packDir);

    const { code, out } = run(["install", packDir, "--store"]);

    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });
});

describe("runPackCli list (#2094)", () => {
  it("should exit 0 and list installed packs without snapshot filesystem paths", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);

    const { code, out } = run(["list", ...STORE()]);

    expect(code).toBe(0);
    expect(out).toContain("com.example.cloud-pack");
    expect(out).toContain("1.2.3");
    expect(out).not.toContain("snapshots");
    expect(out).not.toContain(storeDir);
  });

  it("should print machine-stable JSON when --json is passed", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);

    const { code, out } = run(["list", ...STORE(), "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual([
      {
        packId: "com.example.cloud-pack",
        version: "1.2.3",
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        sourceKind: "local",
        problemCount: 1,
      },
    ]);
    expect(out).not.toContain("snapshotPath");
  });

  it("should exit 0 with an empty result for a fresh store", () => {
    const { code } = run(["list", ...STORE()]);
    expect(code).toBe(0);
  });
});

describe("runPackCli inspect (#2094)", () => {
  it("should exit 0 and show manifest, digest, problem ids, runtimes, and deps without fs paths", () => {
    writeValidPack(packDir, {
      manifestOverrides: { dependencies: [{ id: "com.example.base", range: "^1.0.0" }] },
    });
    run(["install", packDir, ...STORE()]);

    const { code, out } = run(["inspect", "com.example.cloud-pack@1.2.3", ...STORE()]);

    expect(code).toBe(0);
    expect(out).toContain("com.example.cloud-pack");
    expect(out).toContain("hello-world");
    expect(out).toContain("aws/cloudformation");
    expect(out).toContain("com.example.base");
    expect(out).not.toContain("snapshots");
    expect(out).not.toContain(storeDir);
  });

  it("should exit 1 when the requested pack is not installed", () => {
    const { code, out } = run(["inspect", "com.example.nope@1.0.0", ...STORE()]);

    expect(code).toBe(1);
    expect(out.toLowerCase()).toContain("not installed");
  });

  it("should exit 2 when inspect has no pack argument", () => {
    const { code, out } = run(["inspect", ...STORE()]);

    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });

  it("should exit 2 when the pack reference is missing the @version", () => {
    const { code, out } = run(["inspect", "com.example.cloud-pack", ...STORE()]);

    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });
});

describe("runPackCli remove (#2094)", () => {
  it("should exit 0 and remove an unused revision", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);

    const { code } = run(["remove", "com.example.cloud-pack@1.2.3", ...STORE()]);

    expect(code).toBe(0);
    const { out: listOut } = run(["list", ...STORE()]);
    expect(listOut).not.toContain("com.example.cloud-pack");
  });

  it("should exit 1 and refuse when a pin file marks the revision as referenced", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);
    // A pin record (event/deployment/activation) referencing the revision.
    const pinsPath = path.join(base, "pins.json");
    fs.writeFileSync(
      pinsPath,
      JSON.stringify([{ packId: "com.example.cloud-pack", version: "1.2.3" }]),
    );

    const { code, out } = run([
      "remove",
      "com.example.cloud-pack@1.2.3",
      ...STORE(),
      "--pins",
      pinsPath,
    ]);

    expect(code).toBe(1);
    expect(out.toLowerCase()).toContain("pinned");
    // Still installed.
    const { out: listOut } = run(["list", ...STORE()]);
    expect(listOut).toContain("com.example.cloud-pack");
  });

  it("should exit 0 when a pin file exists but does not reference this revision", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);
    const pinsPath = path.join(base, "pins.json");
    fs.writeFileSync(pinsPath, JSON.stringify([{ packId: "com.other.pack", version: "9.9.9" }]));

    const { code } = run([
      "remove",
      "com.example.cloud-pack@1.2.3",
      ...STORE(),
      "--pins",
      pinsPath,
    ]);

    expect(code).toBe(0);
  });

  it("should exit 2 without throwing when the --pins file is missing", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);
    const missingPins = path.join(base, "no-such-pins.json");

    const { code } = run([
      "remove",
      "com.example.cloud-pack@1.2.3",
      ...STORE(),
      "--pins",
      missingPins,
    ]);

    expect(code).toBe(2);
    // The revision must not have been removed on a tool-failure path.
    const { out: listOut } = run(["list", ...STORE()]);
    expect(listOut).toContain("com.example.cloud-pack");
  });

  it("should exit 2 without throwing when the --pins file is malformed JSON", () => {
    writeValidPack(packDir);
    run(["install", packDir, ...STORE()]);
    const badPins = path.join(base, "bad-pins.json");
    fs.writeFileSync(badPins, "{ not valid json");

    const { code } = run([
      "remove",
      "com.example.cloud-pack@1.2.3",
      ...STORE(),
      "--pins",
      badPins,
    ]);

    expect(code).toBe(2);
  });

  it("should exit 1 when the revision is not installed", () => {
    const { code, out } = run(["remove", "com.example.cloud-pack@9.9.9", ...STORE()]);

    expect(code).toBe(1);
    expect(out.toLowerCase()).toContain("not installed");
  });

  it("should exit 2 when remove has no pack argument", () => {
    const { code, out } = run(["remove", ...STORE()]);

    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });

  it("should exit 2 when the pack reference is missing the @version", () => {
    const { code, out } = run(["remove", "com.example.cloud-pack", ...STORE()]);

    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });
});

describe("runPackCli lifecycle dispatcher (#2094)", () => {
  it("should have no update command (a new version is a separate install)", () => {
    const { code, out } = run(["update", "com.example.cloud-pack@2.0.0", ...STORE()]);

    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });

  it("should still dispatch validate (the shared dispatcher is unchanged)", () => {
    writeValidPack(packDir);

    const { code, out } = run(["validate", packDir]);

    expect(code).toBe(0);
    expect(out).toContain("valid");
  });
});
