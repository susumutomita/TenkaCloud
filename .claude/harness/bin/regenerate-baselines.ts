#!/usr/bin/env bun
/**
 * Regenerate baseline files for the architecture harness.
 *
 * Strategy: for each rule, write the current findings as that rule's baseline.
 * This is a one-shot tool for adopting a new rule (= "freeze the current debt,
 * block future debt"). Re-running it for an existing rule is also valid when
 * deliberately re-baselining after a refactor batch.
 *
 * Usage:
 *   bun run .claude/harness/bin/regenerate-baselines.ts <ruleId> [<ruleId>...]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileTooLarge } from "../src/rules/file-too-large.ts";
import { handlerMustNotCallFetch } from "../src/rules/handler-must-not-call-fetch.ts";
import { handlerNoDirectSdkImport } from "../src/rules/handler-no-direct-sdk-import.ts";
import { iamWildcardNeedsJustify } from "../src/rules/iam-wildcard-needs-justify.ts";
import { lambdaEnvSize } from "../src/rules/lambda-env-size.ts";
import { secretsManagerForbidden } from "../src/rules/secrets-manager-forbidden.ts";
import { listAllTrackedFiles } from "../src/utils/staged-files.ts";

const RULES = {
  "file-too-large": fileTooLarge,
  "handler-must-not-call-fetch": handlerMustNotCallFetch,
  "handler-no-direct-sdk-import": handlerNoDirectSdkImport,
  "iam-wildcard-needs-justify": iamWildcardNeedsJustify,
  "lambda-env-size": lambdaEnvSize,
  "secrets-manager-forbidden": secretsManagerForbidden,
} as const;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "usage: regenerate-baselines.ts <ruleId> [<ruleId>...]\nrules: " +
      Object.keys(RULES).join(", "),
  );
  process.exit(1);
}

const cwd = process.cwd();
const files = listAllTrackedFiles({ cwd });
const readFile = (path: string): string => readFileSync(resolve(cwd, path), "utf8");
const ctx = { files, readFile };

for (const ruleId of args) {
  const rule = RULES[ruleId as keyof typeof RULES];
  if (!rule) {
    console.error(`unknown rule: ${ruleId}`);
    process.exit(1);
  }
  const findings = rule.check(ctx);
  const entries = findings.map((f) => ({
    ruleId: f.ruleId,
    filePath: f.filePath,
    line: f.line ?? 1,
    match: f.match ?? "",
  }));
  const outPath = resolve(cwd, `.claude/harness/baselines/${ruleId}.json`);
  writeFileSync(outPath, `${JSON.stringify({ entries }, null, 2)}\n`);
  console.log(`wrote ${outPath} (${entries.length} entries)`);
}
