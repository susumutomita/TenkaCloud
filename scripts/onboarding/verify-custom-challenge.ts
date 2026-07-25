#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { validatePackDirectory } from "@tenkacloud/problem-sdk";
import YAML from "yaml";

const RESERVED_IDS = new Set(["hello-world", "golden-basic-find-the-flag"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GOLDEN_TITLE = "Find the flag";
const GOLDEN_DESCRIPTION =
  "Flag-scored golden problem: deploy emits a CloudFormation output that holds the flag, scored by the built-in flag kind.";
const GOLDEN_HINT = "Inspect the stack Outputs for a value named FlagValue.";
const GOLDEN_FLAG = "TENKA{golden-reference-flag}";

interface VerificationFailure {
  readonly path: string;
  readonly message: string;
}

function fail(failures: readonly VerificationFailure[]): never {
  console.error(`Custom challenge verification failed: ${failures.length} problem(s).`);
  for (const failure of failures) {
    console.error(`  - ${failure.path}: ${failure.message}`);
  }
  process.exit(1);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function main(): void {
  const packDir = process.argv[2];
  if (!packDir) {
    console.error("Usage: bun run onboarding:verify-custom-challenge <pack-dir>");
    process.exit(2);
  }

  const validation = validatePackDirectory(packDir);
  if (!validation.ok) {
    console.error("Standard pack validation failed.");
    for (const diagnostic of validation.diagnostics) {
      console.error(`  [${diagnostic.code}] ${diagnostic.file}:${diagnostic.path}`);
      console.error(`      ${diagnostic.message}`);
    }
    process.exit(1);
  }

  const failures: VerificationFailure[] = [];
  if (validation.problemIds.length !== 2) {
    failures.push({ path: "problems", message: "exactly two problems are required" });
  }
  if (!validation.problemIds.includes("hello-world")) {
    failures.push({ path: "problems", message: "the scaffolded hello-world problem must remain" });
  }

  const custom = validation.problems.find((problem) => problem.id !== "hello-world");
  if (!custom) fail(failures);

  if (!SLUG.test(custom.id)) {
    failures.push({ path: `${custom.relDir}/metadata.json:id`, message: "id must be a kebab-case slug" });
  }
  if (RESERVED_IDS.has(custom.id)) {
    failures.push({ path: `${custom.relDir}/metadata.json:id`, message: "copy the reference, then choose your own id" });
  }
  if (custom.relDir !== `problems/challenges/${custom.id}`) {
    failures.push({
      path: custom.relDir,
      message: "directory must be problems/challenges/<metadata.id>",
    });
  }

  const problemDir = path.join(path.resolve(packDir), custom.relDir);
  const metadataPath = path.join(problemDir, "metadata.json");
  const metadata = readJson(metadataPath);
  const scoring = asRecord(metadata.scoring);
  const runtime = asRecord(metadata.runtime);
  const hints = Array.isArray(scoring?.hints) ? scoring.hints : [];
  const firstHint = asRecord(hints[0]);

  if (metadata.category !== "challenges") {
    failures.push({ path: `${custom.relDir}/metadata.json:category`, message: "category must be challenges" });
  }
  if (typeof metadata.title !== "string" || metadata.title.trim() === "" || metadata.title === GOLDEN_TITLE) {
    failures.push({ path: `${custom.relDir}/metadata.json:title`, message: "set a non-empty custom title" });
  }
  if (
    typeof metadata.description !== "string" ||
    metadata.description.trim() === "" ||
    metadata.description === GOLDEN_DESCRIPTION
  ) {
    failures.push({
      path: `${custom.relDir}/metadata.json:description`,
      message: "set a non-empty custom description",
    });
  }
  if (runtime?.provider !== "aws" || runtime?.engine !== "cloudformation" || runtime?.entry !== "template.yaml") {
    failures.push({ path: `${custom.relDir}/metadata.json:runtime`, message: "keep the aws/cloudformation template.yaml runtime" });
  }
  if (scoring?.kind !== "flag") {
    failures.push({ path: `${custom.relDir}/metadata.json:scoring.kind`, message: "scoring kind must be flag" });
  }
  if (typeof scoring?.flagOutputKey !== "string" || scoring.flagOutputKey.trim() === "") {
    failures.push({ path: `${custom.relDir}/metadata.json:scoring.flagOutputKey`, message: "flagOutputKey is required" });
  }
  if (hints.length === 0 || typeof firstHint?.content !== "string" || firstHint.content.trim() === "") {
    failures.push({ path: `${custom.relDir}/metadata.json:scoring.hints`, message: "at least one non-empty hint is required" });
  } else if (firstHint.content === GOLDEN_HINT) {
    failures.push({ path: `${custom.relDir}/metadata.json:scoring.hints[0].content`, message: "customize the hint" });
  }

  const templatePath = path.join(problemDir, "template.yaml");
  const templateText = fs.readFileSync(templatePath, "utf-8");
  const template = asRecord(YAML.parse(templateText));
  const outputs = asRecord(template?.Outputs);
  const flagOutputKey = typeof scoring?.flagOutputKey === "string" ? scoring.flagOutputKey : "";
  if (!flagOutputKey || !outputs || !(flagOutputKey in outputs)) {
    failures.push({ path: `${custom.relDir}/template.yaml:Outputs`, message: "Outputs must contain scoring.flagOutputKey" });
  }
  if (templateText.includes(GOLDEN_FLAG)) {
    failures.push({ path: `${custom.relDir}/template.yaml`, message: "replace the golden reference flag with your own value" });
  }

  if (failures.length > 0) fail(failures);

  console.log("Custom challenge verified.");
  console.log(`  problemId: ${custom.id}`);
  console.log(`  problems: ${validation.problemIds.length}`);
  console.log(`Checkpoint: TC{CUSTOM-CHALLENGE:${custom.id}}`);
}

main();
