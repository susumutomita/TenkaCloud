import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BaselineFile, isBaselined, loadBaseline } from "./baseline.ts";
import { architectureRules } from "./rules/index.ts";
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

// ルールの正本は rules/index.ts の architectureRules のみ (= 単一レジストリ)。
// 旧実装は cli.ts が独自の ALL_RULES を複製しており、rules/index.ts に登録しただけの
// ルール (no-conflict-markers / no-aws-trademark-fictions を含む) が CLI で実行されない
// 「死んだルール」drift を生んでいた。レジストリを 1 つにして構造的に再発を防ぐ。
const ALL_RULES: readonly Rule[] = architectureRules;

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
  iam-wildcard-needs-justify    Wildcard IAM policies need an inline justification comment.
  file-too-large                Single .ts/.tsx files must not exceed 500 (warn) / 800 (error) lines.
  handler-no-direct-sdk-import  handlers/<x>/index.ts must not import @aws-sdk/client-* directly.
  handler-no-transitive-cdk-import  Lambda handler value-import graphs must not reach aws-cdk-lib.
  lambda-env-size               AWS::Lambda::Function env total must stay under 3KB (4KB hard limit - 1KB margin).

Baselines:
  Each rule may have a baseline file at .claude/harness/baselines/<rule-id>.json.
  Findings that match a baseline entry are suppressed (= legacy debt allowed,
  new violations blocked). Regenerate via:
    bun run .claude/harness/bin/regenerate-baselines.ts <rule-id>
`;

export function run(opts: RunOptions): RunResult {
  const allFiles = listAllTrackedFiles({ cwd: opts.cwd });
  const files = opts.staged ? listStagedFiles({ cwd: opts.cwd }) : allFiles;
  const readFile = (path: string): string => readFileSync(resolve(opts.cwd, path), "utf8");
  const ctx = { files, allFiles, readFile };
  const findings: Finding[] = [];
  for (const rule of ALL_RULES) {
    findings.push(...rule.check(ctx));
  }
  const baseline = loadAllBaselines(resolve(opts.cwd, ".claude/harness/baselines"));
  const activeFindings = findings.filter((finding) => !isBaselined(finding, baseline));
  const failThreshold = SEVERITY_RANK[opts.failOn];
  const triggered = activeFindings.some((f) => SEVERITY_RANK[f.severity] >= failThreshold);
  return { findings: activeFindings, exitCode: triggered ? 2 : 0 };
}

/**
 * Loads all *.json baseline files from `dir` and merges entries.
 *
 * Each rule is encouraged to keep its own baseline file (e.g.
 * `file-too-large.json`, `handler-no-direct-sdk-import.json`) so PRs that ratchet one rule don't
 * collide with PRs that ratchet another.
 */
export function loadAllBaselines(dir: string): BaselineFile {
  let names: readonly string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") return { entries: [] };
    throw err;
  }
  const entries: BaselineFile["entries"][number][] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    // tech-debt-*.json は tech-debt analyzer 所有。 architecture harness は読まない。
    if (name.startsWith("tech-debt-")) continue;
    const file = loadBaseline(join(dir, name));
    entries.push(...file.entries);
  }
  return { entries };
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
