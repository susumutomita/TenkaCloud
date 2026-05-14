import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isBaselined, loadBaseline } from "./baseline.ts";
import { adrMustBeHtml } from "./rules/adr-must-be-html.ts";
import { adrSelfContained } from "./rules/adr-self-contained.ts";
import type { Finding, Rule, Severity } from "./types.ts";
import { listAllTrackedFiles, listStagedFiles } from "./utils/staged-files.ts";

export interface RunOptions {
  readonly cwd: string;
  readonly staged: boolean;
  readonly failOn: Severity;
}

export interface RunResult {
  readonly findings: readonly Finding[];
  readonly exitCode: number;
}

const ALL_RULES: readonly Rule[] = [adrMustBeHtml, adrSelfContained];

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

export function parseArgs(argv: readonly string[]): RunOptions {
  let staged = false;
  let failOn: Severity = "error";
  for (const arg of argv) {
    if (arg === "--staged") staged = true;
    else if (arg.startsWith("--fail-on=")) {
      const value = arg.slice("--fail-on=".length);
      if (value !== "error" && value !== "warning" && value !== "info") {
        throw new Error(`--fail-on= must be one of error|warning|info (got ${value})`);
      }
      failOn = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { cwd: process.cwd(), staged, failOn };
}

export class HelpRequested extends Error {}

export const HELP_TEXT = `architecture.ts — TenkaCloud architecture harness

Usage:
  bun run .claude/harness/bin/architecture.ts [--staged] [--fail-on=error|warning|info]

Options:
  --staged             Inspect only files in 'git diff --cached' (PR / pre-commit mode).
                       Without this, every tracked file is inspected.
  --fail-on=<sev>      Exit non-zero when at least one finding of <sev> or higher is reported.
                       Defaults to 'error'.
  -h, --help           Show this message.

Rules:
  adr-must-be-html     docs/architecture/adr-*.md must not exist (use handwritten .html).
  adr-self-contained   ADR HTML files must not contain chat / phased-rollout traces.
`;

export function run(opts: RunOptions): RunResult {
  const files = opts.staged
    ? listStagedFiles({ cwd: opts.cwd })
    : listAllTrackedFiles({ cwd: opts.cwd });
  const readFile = (path: string): string => readFileSync(resolve(opts.cwd, path), "utf8");
  const ctx = { files, readFile };
  const findings: Finding[] = [];
  for (const rule of ALL_RULES) {
    findings.push(...rule.check(ctx));
  }
  const baseline = loadBaseline(
    resolve(opts.cwd, ".claude/harness/baselines/adr-self-contained.json"),
  );
  const activeFindings = findings.filter((finding) => !isBaselined(finding, baseline));
  const failThreshold = SEVERITY_RANK[opts.failOn];
  const triggered = activeFindings.some((f) => SEVERITY_RANK[f.severity] >= failThreshold);
  return { findings: activeFindings, exitCode: triggered ? 2 : 0 };
}

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "harness: no findings.\n";
  const lines: string[] = [];
  lines.push(`harness: ${findings.length} finding(s).\n`);
  lines.push("## Findings\n");
  for (const f of findings) {
    const loc = f.line ? `${f.filePath}:${f.line}` : f.filePath;
    lines.push(`- [${f.severity}] ${f.ruleId} @ ${loc}`);
    lines.push(`  message: ${f.message}`);
    lines.push(`  recommendation: ${f.recommendation}`);
    lines.push("");
  }
  return lines.join("\n");
}

// avoid unused-warning when imported by tests
void join;
