import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A fresh Codespace must reach a working `make local` with zero manual steps.
 * The chain that guarantees that has three seams this file pins:
 *   1. devcontainer postCreate runs ONE script (codespaces-setup.sh), not a
 *      `cmd && cmd` chain — a bun installed mid-chain is invisible to the
 *      later links (PATH was resolved before the install) and the chain used
 *      to abort, leaving no dependencies and no problems/ submodule.
 *   2. Both the setup script and the bootstrap export ~/.bun/bin onto PATH
 *      right after a possible bun install, before anything calls `bun`.
 *   3. `make local-portal` fails with an actionable message when vite is
 *      missing instead of the bare `vite: command not found` (exit 127).
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const devcontainer = readFileSync(join(REPO_ROOT, ".devcontainer", "devcontainer.json"), "utf8");
const setupScript = readFileSync(
  join(REPO_ROOT, "scripts", "onboard", "codespaces-setup.sh"),
  "utf8",
);
const bootstrap = readFileSync(
  join(REPO_ROOT, "scripts", "onboard", "onboard-bootstrap.sh"),
  "utf8",
);
const startLocalScript = readFileSync(
  join(REPO_ROOT, "scripts", "onboard", "codespaces-start-local.sh"),
  "utf8",
);
const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
const localCli = readFileSync(join(REPO_ROOT, "scripts", "cli", "local-command.ts"), "utf8");
const readmeEn = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const readmeJa = readFileSync(join(REPO_ROOT, "README.ja.md"), "utf8");

/** Slice out one Quickstart subsection so numbered-step assertions can't drift
 *  onto an unrelated "2." elsewhere in the README (e.g. "Deploy on AWS" step 2). */
function extractSection(markdown: string, startHeading: string, endHeading: string): string {
  const start = markdown.indexOf(startHeading);
  expect(start, `heading "${startHeading}" not found`).toBeGreaterThan(-1);
  const end = markdown.indexOf(endHeading, start);
  expect(end, `heading "${endHeading}" not found after "${startHeading}"`).toBeGreaterThan(-1);
  return markdown.slice(start, end);
}

describe("devcontainer postCreate", () => {
  it("should run the single setup script instead of a && chain", () => {
    const { postCreateCommand } = JSON.parse(devcontainer) as { postCreateCommand: string };
    expect(postCreateCommand).toBe("sh scripts/onboard/codespaces-setup.sh");
  });

  it("should auto-start local play on container start so the learner types nothing", () => {
    // The zero-manual-steps promise needs an auto-START, not just an auto-install:
    // a non-technical learner opens the Codespace to an empty port-5175 preview
    // unless something runs `make local` for them. postStart does exactly that.
    const { postStartCommand } = JSON.parse(devcontainer) as { postStartCommand: string };
    expect(postStartCommand).toBe("sh scripts/onboard/codespaces-start-local.sh");
  });

  it("should request an 8-core / 32gb machine so make-local containers actually start", () => {
    // 4-core / 16gb machines OOM-killed the docker-in-docker problem containers
    // (`make local` = dockerd + 3 dev servers + per-problem containers) — the
    // Codespace attached but the drill surface never came up.
    const { hostRequirements } = JSON.parse(devcontainer) as {
      hostRequirements: { cpus: number; memory: string };
    };
    expect(hostRequirements.cpus).toBe(8);
    expect(hostRequirements.memory).toBe("32gb");
  });

  it("should disable git-lfs autoPull so its hook install cannot abort postCreate", () => {
    // The universal:noble base image bundles the git-lfs feature, whose
    // pull-git-lfs-artifacts.sh runs `git lfs update` on create. That collides
    // with the Codespaces fork post-commit hook ("hook already exists"), exits
    // non-zero, and the devcontainer CLI then SKIPS our postCreateCommand — the
    // whole setup never runs. This repo has no LFS files, so autoPull:false
    // skips that pull entirely and loses nothing.
    const { features } = JSON.parse(devcontainer) as {
      features: Record<string, { autoPull?: boolean }>;
    };
    const gitLfs = features["ghcr.io/devcontainers/features/git-lfs:1"];
    expect(gitLfs, "git-lfs feature must be declared to override its options").toBeDefined();
    expect(gitLfs.autoPull).toBe(false);
  });
});

describe("scripts/onboard/codespaces-setup.sh", () => {
  it("should run the pre-bun bootstrap with consent pre-approved", () => {
    expect(setupScript).toContain('sh "$repo_root/scripts/onboard/onboard-bootstrap.sh" --yes');
  });

  it("should export ~/.bun/bin onto PATH before the first bun invocation", () => {
    const pathExport = setupScript.indexOf('export PATH="$BUN_INSTALL/bin:$PATH"');
    const firstBunRun = setupScript.indexOf('bun run "$repo_root');
    expect(pathExport).toBeGreaterThan(-1);
    expect(firstBunRun).toBeGreaterThan(pathExport);
  });

  it("should run the preflight (submodule + Docker diagnosis) with --yes", () => {
    expect(setupScript).toContain(
      'bun run "$repo_root/scripts/tenkacloud-onboard.ts" preflight --yes',
    );
  });

  it("should install workspace dependencies (vite for the portal)", () => {
    expect(setupScript).toContain('make -C "$repo_root" install');
  });

  it("should preinstall the claude and codex CLIs without letting a failure abort setup", () => {
    // `claude` / `codex` must work for in-Codespace debugging out of the box,
    // but a registry outage must not brick the Codespace (set -eu would abort
    // the whole postCreate) — hence the || warn fallback.
    expect(setupScript).toContain("npm install -g @anthropic-ai/claude-code @openai/codex");
    expect(setupScript).toMatch(/\|\| echo "\[codespaces-setup\] WARN: agent CLI install failed/);
  });

  it("should install the agent CLIs from $HOME so the repo .npmrc cannot alter them", () => {
    // The repo .npmrc sets ignore-scripts / min-release-age for PROJECT deps;
    // a global install run from the workspace dir would silently inherit them.
    expect(setupScript).toMatch(/cd "\$HOME" \\\n\s+&& npm install -g/);
  });

  it("should stop on the first failure so a broken setup is loud", () => {
    expect(setupScript).toMatch(/^set -eu$/m);
  });
});

describe("scripts/onboard/codespaces-start-local.sh", () => {
  it("should start `make local` detached so the lifecycle step returns immediately", () => {
    // nohup + & keeps the portal alive past this shell and lets the Codespace
    // finish attaching (blocking here would hang the whole start).
    expect(startLocalScript).toMatch(/nohup make -C "\$repo_root" local .*&\s*$/m);
  });

  it("should export ~/.bun/bin onto PATH before invoking make (make local needs bun)", () => {
    const pathExport = startLocalScript.indexOf('export PATH="$BUN_INSTALL/bin:$PATH"');
    const makeRun = startLocalScript.indexOf("nohup make");
    expect(pathExport).toBeGreaterThan(-1);
    expect(makeRun).toBeGreaterThan(pathExport);
  });

  it("should stop on the first failure so a broken start is loud", () => {
    expect(startLocalScript).toMatch(/^set -eu$/m);
  });

  it("should surface a failed background start instead of reporting success", () => {
    // Backgrounding with nohup+& exits 0 even if `make local` dies, which would
    // silently regress to the empty port-5175 preview. The script must watch the
    // start PID, probe the portal, and exit non-zero when the start process dies.
    expect(startLocalScript).toMatch(/kill -0 "\$start_pid"/);
    expect(startLocalScript).toContain("curl -sf");
    expect(startLocalScript).toMatch(/^\s*exit 1$/m);
  });

  it("should confirm the response is our portal, not any process on 5175", () => {
    // Readiness must not pass on a stale/foreign server (or a PID-reuse race) that
    // merely answers on 5175 — verify the served <title> is the participant portal.
    expect(startLocalScript).toMatch(/curl -sf .*\| grep -q "TenkaCloud Participant Portal"/);
  });

  it("should bound each probe and the whole loop so it cannot hang forever", () => {
    // A bare curl against a server that accepts but never responds would block
    // forever and the loop would never reach its timeout. --max-time bounds each
    // probe; a wall-clock deadline bounds the total.
    expect(startLocalScript).toContain("--max-time");
    expect(startLocalScript).toMatch(/deadline=\$\(\(\s*\$\(date \+%s\)/);
    expect(startLocalScript).toMatch(/while \[ "\$\(date \+%s\)" -lt "\$deadline" \]/);
  });
});

describe("scripts/onboard/onboard-bootstrap.sh", () => {
  it("should put a just-installed bun onto this shell's PATH before re-checking", () => {
    const install = bootstrap.indexOf('sh -c "$bun_cmd"');
    const pathExport = bootstrap.indexOf('export PATH="$BUN_INSTALL/bin:$PATH"');
    const recheck = bootstrap.lastIndexOf("command -v bun");
    expect(install).toBeGreaterThan(-1);
    expect(pathExport).toBeGreaterThan(install);
    expect(recheck).toBeGreaterThan(pathExport);
  });

  // Issue #2907: a real macOS onboarding failed because `brew install oven-sh/bun/bun`
  // broke on an old Xcode / Command Line Tools while the official installer worked.
  // The bootstrap must fall back instead of aborting with brew's error.
  it("should fall back to the official Bun installer when the first route fails (#2907)", () => {
    expect(bootstrap).toContain('bun_official_cmd="curl -fsSL https://bun.sh/install | bash"');
    const brewAttempt = bootstrap.indexOf('if ! sh -c "$bun_cmd"; then');
    const fallback = bootstrap.indexOf('sh -c "$bun_official_cmd"', brewAttempt);
    expect(brewAttempt).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(brewAttempt);
  });
});

describe("Makefile local-play guards", () => {
  it("ensure-deps should auto-run make install when vite is missing (not just error out)", () => {
    // The ensure-deps recipe must install on demand — matched loosely so
    // whitespace/formatting can change without breaking the intent check.
    expect(makefile).toMatch(/ensure-deps:/);
    expect(makefile).toMatch(/vite is missing\)\s*—\s*running 'make install' first/);
    expect(makefile).toMatch(/\$\(MAKE\) install/);
  });

  it("make local should delegate to the self-healing unified CLI", () => {
    const local = makefile.slice(makefile.indexOf("\nlocal:"));
    expect(local.slice(0, 400)).toContain("bun run tenkacloud local");
    expect(localCli).toContain("await ensurePortalDependencies(deps)");
    expect(localCli).toContain('["install", "--ignore-scripts"]');
  });

  // Issue #2907: the CLI's in-process self-heal can never run on a fresh clone —
  // `bun run tenkacloud` dies resolving workspace imports before any code executes —
  // so the make target must run ensure-deps before delegating.
  it("make local should run ensure-deps before the CLI on a fresh clone (#2907)", () => {
    const local = makefile.slice(makefile.indexOf("\nlocal:"));
    const ensure = local.indexOf("$(MAKE) ensure-deps");
    const delegate = local.indexOf("bun run tenkacloud local");
    expect(ensure).toBeGreaterThan(-1);
    expect(ensure).toBeLessThan(delegate);
  });

  it("local-portal should delegate to the same self-healing CLI path", () => {
    const portal = makefile.slice(makefile.indexOf("\nlocal-portal:"));
    expect(portal.slice(0, 200)).toContain("bun run tenkacloud local portal");
  });

  it("local-onboard should reach a bun the bootstrap just installed", () => {
    expect(makefile).toMatch(
      /PATH="\$\$HOME\/\.bun\/bin:\$\$PATH" bun run scripts\/tenkacloud-onboard\.ts preflight/,
    );
  });
});

/**
 * Issue #2696 PR 1: the devcontainer's postStartCommand (pinned above) already
 * auto-starts local play and auto-forwards port 5175 with `openPreview` — but the
 * README still told the reader to manually run the "▷ ローカルプレイ開始" VS Code
 * task as a REQUIRED step, contradicting the auto-start the devcontainer already
 * performs. These tests pin the doc fix: the auto-start must be described as the
 * primary flow, and the task must read as an optional manual re-run (only needed
 * if the auto-start's startup window times out), not a required step.
 */
describe("README does not present the manual local-play task as required (Issue #2696)", () => {
  it("should describe the Participant Portal as opening automatically in README.md", () => {
    const section = extractSection(
      readmeEn,
      "### Try it in your browser (GitHub Codespaces, zero install)",
      "### Try it locally (no AWS)",
    );
    expect(section).toMatch(/Participant Portal opens automatically/);
  });

  it("should describe the Participant Portal as opening automatically in README.ja.md", () => {
    const section = extractSection(
      readmeJa,
      "### ブラウザで試す(GitHub Codespaces、インストール不要)",
      "### ローカルで試す(AWS 不要)",
    );
    expect(section).toMatch(/Participant Portal も自動でプレビュータブに開く/);
  });

  it("should mark the ▷ ローカルプレイ開始 task as an optional manual re-run in README.md, not a required numbered step", () => {
    const section = extractSection(
      readmeEn,
      "### Try it in your browser (GitHub Codespaces, zero install)",
      "### Try it locally (no AWS)",
    );
    const taskIndex = section.indexOf("ローカルプレイ開始");
    expect(taskIndex).toBeGreaterThan(-1);
    // The task mention must be preceded (within the same section) by the
    // "optional manual re-run" callout, not appear as one of the 1./2./3. steps.
    expect(section.slice(0, taskIndex)).toMatch(/Optional manual re-run/i);
    const numberedSteps = section.split("\n").filter((line) => /^\d+\.\s/.test(line));
    expect(numberedSteps.some((line) => line.includes("ローカルプレイ開始"))).toBe(false);
  });

  it("should mark the ▷ ローカルプレイ開始 task as an optional manual re-run in README.ja.md, not a required numbered step", () => {
    const section = extractSection(
      readmeJa,
      "### ブラウザで試す(GitHub Codespaces、インストール不要)",
      "### ローカルで試す(AWS 不要)",
    );
    const taskIndex = section.indexOf("ローカルプレイ開始");
    expect(taskIndex).toBeGreaterThan(-1);
    expect(section.slice(0, taskIndex)).toMatch(/任意の手動再実行/);
    const numberedSteps = section.split("\n").filter((line) => /^\d+\.\s/.test(line));
    expect(numberedSteps.some((line) => line.includes("ローカルプレイ開始"))).toBe(false);
  });
});
