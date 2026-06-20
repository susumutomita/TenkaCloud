#!/usr/bin/env bun
/**
 * ADR-012 Phase 6: `tenkacloud problem` CLI subcommand 群。
 *
 * The implementation lives under `scripts/problem-cli/`; this file stays as a thin
 * CLI entrypoint and compatibility export surface for tests/importers.
 */

import { createInterface } from "node:readline/promises";

import { type CliArgs, parseArgs } from "./problem-cli/args";
import { runCost } from "./problem-cli/cost";
import { runCreate } from "./problem-cli/create";
import { runDryRun } from "./problem-cli/dry-run";
import { listKinds, printHelp } from "./problem-cli/help";
import { runInspect } from "./problem-cli/inspect";
import { runInteractive } from "./problem-cli/interactive";
import { runValidate } from "./problem-cli/validate";

export { type CliArgs, parseArgs } from "./problem-cli/args";
export { KIND_TO_DEFAULT_CATEGORY, KINDS, type Kind } from "./problem-cli/constants";
export { type CostResult, runCost } from "./problem-cli/cost";
export { applyPlaceholders, type CreateResult, runCreate } from "./problem-cli/create";
export { type DryRunArgs, type DryRunResult, runDryRun } from "./problem-cli/dry-run";
export { listKinds, printHelp } from "./problem-cli/help";
export { type InspectResult, runInspect } from "./problem-cli/inspect";
export {
  type InteractivePrompts,
  type RunInteractiveResult,
  runInteractive,
} from "./problem-cli/interactive";
export { findProblemDir, readProblemMetadata } from "./problem-cli/problem-loader";
export { extractFlagFromTemplate, inspectTemplateSections } from "./problem-cli/template-inspector";
export { runValidate, type ValidateResult } from "./problem-cli/validate";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "help":
      printHelp();
      return;
    case "list-kinds":
      listKinds();
      return;
    case "interactive": {
      await handleInteractive();
      return;
    }
    case "create": {
      handleCreate(args);
      return;
    }
    case "validate": {
      handleValidate(args);
      return;
    }
    case "cost": {
      handleCost(args);
      return;
    }
    case "dry-run": {
      handleDryRun(args);
      return;
    }
    case "inspect": {
      handleInspect(args);
      return;
    }
    default: {
      const _exhaustive: never = args.command;
      throw new Error(`unhandled command: ${String(_exhaustive)}`);
    }
  }
}

async function handleInteractive(): Promise<void> {
  // Issue #954: stdin / stdout を持つ default prompts で対話モード起動。
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runInteractive({
      ask: (q) => rl.question(q),
      print: (line) => console.log(line),
    });
  } finally {
    rl.close();
  }
}

function handleCreate(args: CliArgs): void {
  if (!args.kind) {
    throw new Error("create requires --kind <kind>. Use 'list-kinds' to see options.");
  }
  const r = runCreate({
    problemId: args.problemId ?? "",
    kind: args.kind,
    ...(args.category ? { category: args.category } : {}),
  });
  console.log(
    `Created ${r.outputDir}\n  category: ${r.category}\n  kind:     ${r.kind}\n\nNext steps:\n  1. Edit ${r.outputDir}/metadata.json (name / description / tags / learningGoals)\n  2. Edit ${r.outputDir}/template.yaml (実 AWS リソース)\n  3. bun run scripts/tenkacloud-problem.ts cost ${args.problemId}\n  4. bun run scripts/tenkacloud-problem.ts validate ${args.problemId}\n  5. make validate-problems`,
  );
}

function handleValidate(args: CliArgs): void {
  const r = runValidate(args.problemId ?? "");
  if (r.ok) {
    console.log(`OK ${args.problemId}`);
  } else {
    console.error(`NG ${args.problemId}:`);
    for (const e of r.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

function handleCost(args: CliArgs): void {
  const r = runCost({ problemId: args.problemId ?? "" });
  if (!r.ok) {
    console.error(`NG ${r.summary}`);
    process.exit(1);
  }
  for (const line of r.lines) console.log(line);
  console.log(`\nsummary: ${r.summary}`);
}

function handleDryRun(args: CliArgs): void {
  const r = runDryRun({
    problemId: args.problemId ?? "",
    ...(args.submitted !== undefined ? { submitted: args.submitted } : {}),
    ...(args.revealHints !== undefined ? { revealHints: args.revealHints } : {}),
    ...(args.cycles !== undefined ? { cycles: args.cycles } : {}),
    ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
  });
  if (!r.ok) {
    console.error(`NG ${r.summary}`);
    process.exit(1);
  }
  for (const line of r.lines) console.log(line);
  console.log(`\nsummary: ${r.summary}`);
}

function handleInspect(args: CliArgs): void {
  const r = runInspect({ problemId: args.problemId ?? "" });
  if (!r.ok) {
    console.error(`NG ${r.summary}`);
    process.exit(1);
  }
  for (const line of r.lines) console.log(line);
}

// CLI 起動と test import を区別するため main module check。
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
