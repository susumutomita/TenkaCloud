import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BaselineFile, isBaselined, loadBaseline } from "../baseline.ts";
import type { Finding, Rule, Severity } from "../types.ts";
import { listAllTrackedFiles, listStagedFiles } from "../utils/staged-files.ts";
import { assertionRoulette } from "./assertion-roulette.ts";
import { circularDependency } from "./circular-dependency.ts";
import { highCoupling } from "./high-coupling.ts";
import { magicNumber } from "./magic-number.ts";

export const TECH_DEBT_RULES: readonly Rule[] = [
  assertionRoulette,
  highCoupling,
  magicNumber,
  circularDependency,
];

export interface RunOptions {
  readonly cwd: string;
  readonly staged: boolean;
  readonly failOn: Severity;
  /** When set, write the current findings as the per-rule baselines. */
  readonly baseline: boolean;
}

export interface RunResult {
  readonly findings: readonly Finding[];
  readonly exitCode: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

export class HelpRequested extends Error {}

export const HELP_TEXT = `tech-debt.ts — TenkaCloud tech-debt analyzer

Usage:
  bun run .claude/harness/bin/tech-debt.ts [--staged] [--fail-on=error|warning|info] [--baseline]

Options:
  --staged             Inspect only files in 'git diff --cached' (PR / pre-commit mode).
                       Without this, every tracked file is inspected.
  --fail-on=<sev>      Exit non-zero when at least one finding of <sev> or higher is reported.
                       Defaults to 'warning' (= one knob looser than the architecture harness,
                       since tech-debt is advisory).
  --baseline           Write the current findings into
                       .claude/harness/baselines/tech-debt-<rule>.json and exit 0.
                       Use this to "freeze the current debt, block new regressions".
  -h, --help           Show this message.

Rules:
  assertion-roulette   Test files with > 5 expect() calls per it()/test() block.
  high-coupling        Production files importing >= 16 modules at top (>= 41 -> error).
  magic-number         Status codes / timeouts / ports as numeric literals in production code.
  circular-dependency  ES module import cycles detected via Tarjan SCC (size >= 4 -> error).
                       In-tree implementation; no dep on madge or any external tool.

Baselines:
  Per-rule baseline at .claude/harness/baselines/tech-debt-<rule-id>.json.
  Regenerate via:
    bun run .claude/harness/bin/tech-debt.ts --baseline
`;

export function parseArgs(argv: readonly string[]): RunOptions {
  let staged = false;
  let failOn: Severity = "warning";
  let baseline = false;
  for (const arg of argv) {
    if (arg === "--staged") staged = true;
    else if (arg === "--baseline") baseline = true;
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
  return { cwd: process.cwd(), staged, failOn, baseline };
}

export function run(opts: RunOptions): RunResult {
  const files = opts.staged
    ? listStagedFiles({ cwd: opts.cwd })
    : listAllTrackedFiles({ cwd: opts.cwd });
  const readFile = (path: string): string => readFileSync(resolve(opts.cwd, path), "utf8");
  const ctx = { files, readFile };
  const findings: Finding[] = [];
  for (const rule of TECH_DEBT_RULES) {
    findings.push(...rule.check(ctx));
  }
  if (opts.baseline) {
    writeBaselines(opts.cwd, findings);
    return { findings, exitCode: 0 };
  }
  const baseline = loadTechDebtBaselines(resolve(opts.cwd, ".claude/harness/baselines"));
  const activeFindings = findings.filter((finding) => !isBaselined(finding, baseline));
  const failThreshold = SEVERITY_RANK[opts.failOn];
  const triggered = activeFindings.some((f) => SEVERITY_RANK[f.severity] >= failThreshold);
  return { findings: activeFindings, exitCode: triggered ? 2 : 0 };
}

/**
 * tech-debt baselines live alongside the architecture baselines but are prefixed
 * `tech-debt-` so the architecture harness ignores them and the tech-debt analyzer
 * picks only its own.
 */
export function loadTechDebtBaselines(dir: string): BaselineFile {
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
    if (!name.startsWith("tech-debt-")) continue;
    if (!name.endsWith(".json")) continue;
    const file = loadBaseline(join(dir, name));
    entries.push(...file.entries);
  }
  return { entries };
}

function writeBaselines(cwd: string, findings: readonly Finding[]): void {
  const dir = resolve(cwd, ".claude/harness/baselines");
  const byRule = new Map<string, ReturnType<typeof toBaselineEntry>[]>();
  for (const rule of TECH_DEBT_RULES) byRule.set(rule.id, []);
  for (const f of findings) {
    const arr = byRule.get(f.ruleId);
    if (!arr) continue;
    arr.push(toBaselineEntry(f));
  }
  for (const [ruleId, entries] of byRule) {
    const outPath = join(dir, `tech-debt-${ruleId}.json`);
    writeFileSync(outPath, `${JSON.stringify({ entries }, null, 2)}\n`);
    // intentionally no console.log here; CLI runner handles user-facing output.
  }
}

function toBaselineEntry(f: Finding): {
  ruleId: string;
  filePath: string;
  line: number;
  match: string;
} {
  return {
    ruleId: f.ruleId,
    filePath: f.filePath,
    line: f.line ?? 1,
    match: f.match ?? "",
  };
}

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "tech-debt: no findings.\n";
  const lines: string[] = [];
  // Group by ruleId to ease scanning, matching the "list per rule" style requested in #1227.
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    let arr = byRule.get(f.ruleId);
    if (!arr) {
      arr = [];
      byRule.set(f.ruleId, arr);
    }
    arr.push(f);
  }
  lines.push(`tech-debt: ${findings.length} finding(s) across ${byRule.size} rule(s).\n`);
  for (const [ruleId, rows] of byRule) {
    lines.push(`## ${ruleId} (${rows.length})\n`);
    for (const f of rows) {
      const loc = f.line ? `${f.filePath}:${f.line}` : f.filePath;
      lines.push(`- [${f.severity}] ${loc}`);
      lines.push(`  ${f.message}`);
      lines.push(`  recommendation: ${f.recommendation}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
