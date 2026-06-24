#!/usr/bin/env bun
/**
 * Quality-gate runner — the single entry point for the checks that live OFF the
 * product body (relocated out of the Makefile `GATE_CHECKS` / CI into this skill
 * so the body and the quality checks are no longer mixed). Always run from the
 * repo root; every check resolves its scan roots from `process.cwd()`.
 *
 * Groups (preserve the original Makefile gate semantics):
 *   - precommit : fast, deterministic file/git scans. The pre-commit hook runs
 *                 these so quality checks still run before every commit.
 *   - ci        : need build artifacts or network (lcov / cdk.out / origin/main).
 *                 CI runs them after producing the artifacts.
 *   - ondemand  : valuable but false-positive prone (intentionally-vulnerable
 *                 problem templates, legacy templates). Run via `/quality-gates`
 *                 where Claude reviews the output (AI + script combo) rather than
 *                 hard-failing a commit.
 *
 * Usage (from repo root):
 *   bun run .claude/skills/quality-gates/scripts/run.ts            # precommit group
 *   bun run .claude/skills/quality-gates/scripts/run.ts --ci       # precommit + ci
 *   bun run .claude/skills/quality-gates/scripts/run.ts --all      # everything
 *   bun run .claude/skills/quality-gates/scripts/run.ts http-magic-numbers ...
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Group = "precommit" | "ci" | "ondemand";
type Check = { name: string; script: string; group: Group; needs?: string };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const CHECKS: Check[] = [
  { name: "http-magic-numbers", script: "check-http-magic-numbers.ts", group: "precommit" },
  { name: "no-conflicts", script: "check-no-conflicts.ts", group: "precommit" },
  { name: "template-ascii", script: "check-template-ascii.ts", group: "precommit" },
  { name: "template-cfn-refs", script: "check-template-cfn-refs.ts", group: "precommit" },
  { name: "template-name-limits", script: "check-template-name-limits.ts", group: "precommit" },
  // synth-iam-ascii runs after `make before-commit` (check-synth) has populated infrastructure/cdk.out.
  {
    name: "synth-iam-ascii",
    script: "check-synth-iam-ascii.ts",
    group: "precommit",
    needs: "make synth (infrastructure/cdk.out)",
  },
  {
    name: "coverage-gate",
    script: "check-coverage-gate.ts",
    group: "ci",
    needs: "make test-coverage (coverage/lcov.info)",
  },
  {
    name: "submodule-not-behind",
    script: "check-submodule-not-behind.ts",
    group: "ci",
    needs: "origin/main + submodule history",
  },
  { name: "template-security", script: "check-template-security.ts", group: "ondemand" },
  { name: "template-cli-access", script: "check-template-cli-access.ts", group: "ondemand" },
];

function select(argv: string[]): Check[] {
  const named = argv.filter((a) => !a.startsWith("--"));
  if (named.length > 0) {
    return named.map((n) => {
      const c = CHECKS.find((x) => x.name === n);
      if (!c) {
        console.error(`unknown check: ${n}\nknown: ${CHECKS.map((x) => x.name).join(", ")}`);
        process.exit(2);
      }
      return c;
    });
  }
  if (argv.includes("--all")) return CHECKS;
  if (argv.includes("--ci")) return CHECKS.filter((c) => c.group !== "ondemand");
  return CHECKS.filter((c) => c.group === "precommit");
}

const selected = select(process.argv.slice(2));
console.log(
  `quality-gates: running ${selected.length} check(s) [${selected.map((c) => c.name).join(", ")}]\n`,
);

const failed: string[] = [];
for (const check of selected) {
  console.log(`──▶ ${check.name}${check.needs ? `  (needs: ${check.needs})` : ""}`);
  const res = spawnSync("bun", ["run", join(SCRIPT_DIR, check.script)], { stdio: "inherit" });
  if (res.status !== 0) failed.push(check.name);
  console.log("");
}

if (failed.length > 0) {
  console.error(`quality-gates: FAILED — ${failed.join(", ")}`);
  process.exit(1);
}
console.log("quality-gates: all checks passed");
