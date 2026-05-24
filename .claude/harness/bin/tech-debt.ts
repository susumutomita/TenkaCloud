#!/usr/bin/env bun
import {
  formatFindings,
  HELP_TEXT,
  HelpRequested,
  parseArgs,
  run,
  TECH_DEBT_RULES,
} from "../src/tech-debt/index.ts";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = run(options);
  if (options.baseline) {
    const counts = new Map<string, number>();
    for (const rule of TECH_DEBT_RULES) counts.set(rule.id, 0);
    for (const f of result.findings) counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
    const parts: string[] = [];
    for (const [ruleId, n] of counts) parts.push(`${ruleId}=${n}`);
    console.log(`tech-debt: baselines written (${parts.join(", ")}).`);
    process.exit(0);
  }
  const output = formatFindings(result.findings);
  if (result.exitCode === 0) console.log(output.trimEnd());
  else console.error(output.trimEnd());
  process.exit(result.exitCode);
} catch (err) {
  if (err instanceof HelpRequested) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tech-debt analyzer failed: ${message}`);
  process.exit(1);
}
