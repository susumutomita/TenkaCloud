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

export interface VerificationFailure {
  readonly path: string;
  readonly message: string;
}

/**
 * Issue #2781: the tutorial-only checkpoint. The standard Problem Pack validator
 * cannot express "you added a SECOND problem and made it your own", so this
 * verifier layers the drill's completion condition on top of it and prints a
 * checkpoint the participant submits in the portal.
 */
export type VerificationResult =
  | {
      readonly ok: true;
      readonly problemId: string;
      readonly problemCount: number;
      readonly checkpoint: string;
    }
  | { readonly ok: false; readonly failures: readonly VerificationFailure[] };

export function formatCheckpoint(problemId: string): string {
  return `TC{CUSTOM-CHALLENGE:${problemId}}`;
}

/**
 * The subset of `metadata.json` this drill grades, declared as all-optional so a
 * malformed pack narrows to `undefined` through optional chaining instead of
 * throwing. `validatePackDirectory` has already rejected structurally invalid
 * metadata by the time we read these, so this only has to describe the fields the
 * tutorial asserts on — no generic record-narrowing helper is needed.
 */
interface CustomChallengeMetadata {
  readonly category?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly runtime?: {
    readonly provider?: unknown;
    readonly engine?: unknown;
    readonly entry?: unknown;
  };
  readonly scoring?: {
    readonly kind?: unknown;
    readonly flagOutputKey?: unknown;
    readonly hints?: readonly { readonly content?: unknown }[];
  };
}

function readJson(file: string): CustomChallengeMetadata {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as CustomChallengeMetadata;
}

/** The pack must GAIN a problem, not have its scaffold rewritten in place. */
function checkProblemSet(problemIds: readonly string[]): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  if (problemIds.length !== 2) {
    failures.push({ path: "problems", message: "exactly two problems are required" });
  }
  if (!problemIds.includes("hello-world")) {
    failures.push({ path: "problems", message: "the scaffolded hello-world problem must remain" });
  }
  return failures;
}

/** The author's own id, and the directory layout the catalog resolves it by. */
function checkIdentity(id: string, relDir: string): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  if (!SLUG.test(id)) {
    failures.push({ path: `${relDir}/metadata.json:id`, message: "id must be a kebab-case slug" });
  }
  if (RESERVED_IDS.has(id)) {
    failures.push({
      path: `${relDir}/metadata.json:id`,
      message: "copy the reference, then choose your own id",
    });
  }
  if (relDir !== `problems/challenges/${id}`) {
    failures.push({
      path: relDir,
      message: "directory must be problems/challenges/<metadata.id>",
    });
  }
  return failures;
}

/** Every field the drill requires the author to actually make their own. */
function checkMetadata(metadata: CustomChallengeMetadata, relDir: string): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  const at = (suffix: string) => `${relDir}/metadata.json:${suffix}`;
  const { scoring, runtime } = metadata;
  const hints = Array.isArray(scoring?.hints) ? scoring.hints : [];
  const firstHint = hints[0];

  if (metadata.category !== "challenges") {
    failures.push({ path: at("category"), message: "category must be challenges" });
  }
  if (!isCustomText(metadata.title, GOLDEN_TITLE)) {
    failures.push({ path: at("title"), message: "set a non-empty custom title" });
  }
  if (!isCustomText(metadata.description, GOLDEN_DESCRIPTION)) {
    failures.push({ path: at("description"), message: "set a non-empty custom description" });
  }
  if (
    runtime?.provider !== "aws" ||
    runtime?.engine !== "cloudformation" ||
    runtime?.entry !== "template.yaml"
  ) {
    failures.push({
      path: at("runtime"),
      message: "keep the aws/cloudformation template.yaml runtime",
    });
  }
  if (scoring?.kind !== "flag") {
    failures.push({ path: at("scoring.kind"), message: "scoring kind must be flag" });
  }
  if (typeof scoring?.flagOutputKey !== "string" || scoring.flagOutputKey.trim() === "") {
    failures.push({ path: at("scoring.flagOutputKey"), message: "flagOutputKey is required" });
  }
  if (typeof firstHint?.content !== "string" || firstHint.content.trim() === "") {
    failures.push({
      path: at("scoring.hints"),
      message: "at least one non-empty hint is required",
    });
  } else if (firstHint.content === GOLDEN_HINT) {
    failures.push({ path: at("scoring.hints[0].content"), message: "customize the hint" });
  }
  return failures;
}

/** The template must emit the scored output and must not ship the golden flag. */
function checkTemplate(
  templateText: string,
  flagOutputKey: unknown,
  relDir: string,
): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  const template = YAML.parse(templateText) as { readonly Outputs?: unknown } | null | undefined;
  const outputs = template?.Outputs;
  const hasOutputsMapping =
    typeof outputs === "object" && outputs !== null && !Array.isArray(outputs);
  const key = typeof flagOutputKey === "string" ? flagOutputKey : "";
  if (!key || !hasOutputsMapping || !(key in outputs)) {
    failures.push({
      path: `${relDir}/template.yaml:Outputs`,
      message: "Outputs must contain scoring.flagOutputKey",
    });
  }
  if (templateText.includes(GOLDEN_FLAG)) {
    failures.push({
      path: `${relDir}/template.yaml`,
      message: "replace the golden reference flag with your own value",
    });
  }
  return failures;
}

function isCustomText(value: unknown, goldenValue: string): boolean {
  return typeof value === "string" && value.trim() !== "" && value !== goldenValue;
}

/**
 * Pure verification: reads the pack directory and returns the drill outcome. Does
 * no console I/O and never exits, so it is unit-testable and reusable.
 */
export function verifyCustomChallengePack(packDir: string): VerificationResult {
  const validation = validatePackDirectory(packDir);
  if (!validation.ok) {
    return {
      ok: false,
      failures: validation.diagnostics.map((diagnostic) => ({
        path: `${diagnostic.file}:${diagnostic.path}`,
        message: `[${diagnostic.code}] ${diagnostic.message}`,
      })),
    };
  }

  const failures = [...checkProblemSet(validation.problemIds)];
  const custom = validation.problems.find((problem) => problem.id !== "hello-world");
  if (!custom) {
    failures.push({
      path: "problems",
      message: "add your own challenge as a second problem next to hello-world",
    });
    return { ok: false, failures };
  }

  const problemDir = path.join(path.resolve(packDir), custom.relDir);
  const metadata = readJson(path.join(problemDir, "metadata.json"));
  const templateText = fs.readFileSync(path.join(problemDir, "template.yaml"), "utf-8");

  failures.push(
    ...checkIdentity(custom.id, custom.relDir),
    ...checkMetadata(metadata, custom.relDir),
    ...checkTemplate(templateText, metadata.scoring?.flagOutputKey, custom.relDir),
  );

  if (failures.length > 0) return { ok: false, failures };

  return {
    ok: true,
    problemId: custom.id,
    problemCount: validation.problemIds.length,
    checkpoint: formatCheckpoint(custom.id),
  };
}

function main(): void {
  const packDir = process.argv[2];
  if (!packDir) {
    console.error("Usage: bun run onboarding:verify-custom-challenge <pack-dir>");
    process.exit(2);
  }

  const result = verifyCustomChallengePack(packDir);
  if (!result.ok) {
    console.error(`Custom challenge verification failed: ${result.failures.length} problem(s).`);
    for (const failure of result.failures) {
      console.error(`  - ${failure.path}: ${failure.message}`);
    }
    process.exit(1);
  }

  console.log("Custom challenge verified.");
  console.log(`  problemId: ${result.problemId}`);
  console.log(`  problems: ${result.problemCount}`);
  console.log(`Checkpoint: ${result.checkpoint}`);
}

// CLI 実行時のみ走らせる (test から import しても副作用が起きないように)。
if (import.meta.main) main();
