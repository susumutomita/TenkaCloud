/**
 * [Problem Packs / Issue #2097] CLI-level tests for `pack install git <url>
 * --commit <sha> [--subdir <path>]` on the same offline dispatcher the other
 * subcommands use.
 *
 * The Git transport is injected through {@link runPackCli}'s optional deps so the
 * suite runs FULLY OFFLINE — no network, no process spawn. Exit-code contract
 * (shared with the rest of the CLI): 0 success, 1 lifecycle refusal (invalid
 * source / digest or compose conflict), 2 tool failure (bad usage / missing flag).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitArchiveFetcher } from "../../lib/problem-pack/git-source";
import { runPackCli } from "../../lib/problem-pack/pack-cli";

let base: string;
let storeDir: string;

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
const HTTPS_URL = "https://github.com/example/cloud-pack.git";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tenkacloud-pack-cli-git-"));
  storeDir = path.join(base, "store");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function writeValidPack(dir: string, problemId = "hello-world"): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tenkacloud-pack.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "com.example.cloud-pack",
        version: "1.2.3",
        core: "^1.0.0",
        title: "Example Cloud Pack",
        description: "A sample pack of cloud problems.",
        license: "Apache-2.0",
        problemsRoot: "problems",
        requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
      },
      null,
      2,
    ),
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

const fixtureFetcher: GitArchiveFetcher = (request) => {
  writeValidPack(request.destinationDir);
};

function run(
  args: readonly string[],
  fetcher: GitArchiveFetcher = fixtureFetcher,
): { code: number; out: string } {
  const lines: string[] = [];
  const code = runPackCli(args, (line) => lines.push(line), { gitFetcher: fetcher });
  return { code, out: lines.join("\n") };
}

const STORE = () => ["--store", storeDir];

describe("runPackCli install git (#2097)", () => {
  it("should exit 0 and install a pinned Git revision with git source kind", () => {
    const { code, out } = run(["install", "git", HTTPS_URL, "--commit", FULL_SHA, ...STORE()]);

    expect(code).toBe(0);
    expect(out).toContain("com.example.cloud-pack");
    expect(out).toContain("git");
    expect(out).toMatch(/[0-9a-f]{64}/);
  });

  it("should pass a --subdir through to the transport", () => {
    const fetcher = vi.fn<GitArchiveFetcher>((request) => {
      writeValidPack(request.destinationDir);
    });

    const { code } = run(
      ["install", "git", HTTPS_URL, "--commit", FULL_SHA, "--subdir", "packs/cloud", ...STORE()],
      fetcher,
    );

    expect(code).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toMatchObject({ subdir: "packs/cloud" });
  });

  it("should exit 1 and refuse a branch name without calling the transport", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();

    const { code, out } = run(
      ["install", "git", HTTPS_URL, "--commit", "main", ...STORE()],
      fetcher,
    );

    expect(code).toBe(1);
    expect(out.toLowerCase()).toContain("commit");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should exit 1 and refuse a short SHA", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    const { code } = run(["install", "git", HTTPS_URL, "--commit", "0123456", ...STORE()], fetcher);
    expect(code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should exit 1 and refuse a non-HTTPS URL", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    const { code } = run(
      ["install", "git", "ssh://git@github.com/x/y.git", "--commit", FULL_SHA, ...STORE()],
      fetcher,
    );
    expect(code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should exit 1 and refuse a URL with embedded credentials", () => {
    const fetcher = vi.fn<GitArchiveFetcher>();
    const { code } = run(
      ["install", "git", "https://user:pass@github.com/x/y.git", "--commit", FULL_SHA, ...STORE()],
      fetcher,
    );
    expect(code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should exit 2 when the git URL is missing", () => {
    const { code, out } = run(["install", "git", "--commit", FULL_SHA, ...STORE()]);
    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });

  it("should exit 2 when --commit is missing", () => {
    const { code, out } = run(["install", "git", HTTPS_URL, ...STORE()]);
    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });

  it("should exit 2 when --commit is given with no value", () => {
    const { code, out } = run(["install", "git", HTTPS_URL, "--commit", ...STORE()]);
    expect(code).toBe(2);
    expect(out.toLowerCase()).toContain("usage");
  });

  it("should still install a LOCAL pack directory unchanged (no git keyword)", () => {
    const packDir = path.join(base, "local-pack");
    writeValidPack(packDir);

    const { code, out } = run(["install", packDir, ...STORE()]);

    expect(code).toBe(0);
    expect(out).toContain("local");
    expect(out).not.toContain("git");
  });
});
