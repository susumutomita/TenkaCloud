/**
 * [Problem Packs / Issue #2089] Tests for the `pack init` subcommand on the
 * SAME CLI dispatcher that `pack validate` (#2088) uses.
 *
 * The CLI stays a pure function over (args, lineSink) returning an exit code, so
 * the suite is deterministic and offline. Exit-code contract is shared with
 * `validate`: 0 success, 2 tool failure (bad usage / unsafe target / non-empty dir).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackCli } from "../../lib/problem-pack/pack-cli";
import { validatePackDirectory } from "../../lib/problem-pack/validate-pack";

let targetRoot: string;

beforeEach(() => {
  targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-cli-init-"));
});

afterEach(() => {
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

describe("runPackCli init (#2089)", () => {
  it("should exit 0 and scaffold a validator-passing pack into an empty dir", () => {
    const dir = path.join(targetRoot, "new-pack");
    const out: string[] = [];

    const code = runPackCli(["init", dir], (line) => out.push(line));

    expect(code).toBe(0);
    expect(validatePackDirectory(dir).ok).toBe(true);
  });

  it("should scaffold the requested runtime artifact when --runtime is passed", () => {
    const dir = path.join(targetRoot, "gcp-pack");

    const code = runPackCli(["init", dir, "--runtime", "gcp/infra-manager"], () => {});

    expect(code).toBe(0);
    const result = validatePackDirectory(dir);
    expect(result.ok).toBe(true);
    expect(result.manifest?.requiredRuntimes).toEqual([
      { provider: "gcp", engine: "infra-manager" },
    ]);
  });

  it("should exit 2 when init has no directory argument", () => {
    const out: string[] = [];

    const code = runPackCli(["init"], (line) => out.push(line));

    expect(code).toBe(2);
    expect(out.join("\n").toLowerCase()).toContain("usage");
  });

  it("should exit 2 when the target directory is not empty", () => {
    fs.writeFileSync(path.join(targetRoot, "keep.txt"), "x");
    const out: string[] = [];

    const code = runPackCli(["init", targetRoot], (line) => out.push(line));

    expect(code).toBe(2);
    expect(out.join("\n").toLowerCase()).toContain("not empty");
  });

  it("should exit 2 on an unsupported --runtime value", () => {
    const dir = path.join(targetRoot, "bad-runtime");
    const out: string[] = [];

    const code = runPackCli(["init", dir, "--runtime", "aws/sam"], (line) => out.push(line));

    expect(code).toBe(2);
    expect(out.join("\n").toLowerCase()).toContain("unsupported runtime");
  });

  it("should still dispatch validate (the shared dispatcher is unchanged)", () => {
    const dir = path.join(targetRoot, "round-trip");
    runPackCli(["init", dir], () => {});
    const out: string[] = [];

    const code = runPackCli(["validate", dir], (line) => out.push(line));

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("valid");
  });
});
