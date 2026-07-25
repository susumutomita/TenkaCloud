import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatCheckpoint,
  verifyCustomChallengePack,
} from "../../../scripts/onboarding/verify-custom-challenge";
import { writePackScaffold } from "../../lib/problem-pack/init-pack";

/**
 * Issue #2781: the final onboarding drill moves the learner from solving to
 * authoring. The standard pack validator cannot express its completion condition
 * ("you ADDED a second problem and made it your own"), so this verifier layers it
 * on top. These tests drive the real `pack init` scaffold plus the real golden
 * challenge, so the drill can never silently accept a copy-paste.
 */

const GOLDEN_CHALLENGE_DIR = path.resolve(
  __dirname,
  "../../../packs/golden/basic-aws-pack/problems/challenges/find-the-flag",
);

const workspaces: string[] = [];

function makePack(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-custom-challenge-"));
  workspaces.push(dir);
  const packDir = path.join(dir, "my-first-pack");
  writePackScaffold(packDir, { packId: "com.example.starter" });
  return packDir;
}

/** Copy the golden flag-scored challenge in as the pack's second problem. */
function addSecondProblem(packDir: string, problemId: string): string {
  const dest = path.join(packDir, "problems", "challenges", problemId);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ["metadata.json", "template.yaml"]) {
    fs.copyFileSync(path.join(GOLDEN_CHALLENGE_DIR, file), path.join(dest, file));
  }
  const metadataPath = path.join(dest, "metadata.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
  metadata.id = problemId;
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return dest;
}

/** Rewrite every field the drill requires the author to make their own. */
function customize(problemDir: string): void {
  const metadataPath = path.join(problemDir, "metadata.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
  metadata.title = "Find the forgotten bucket";
  metadata.description = "Deploy the stack and read the flag it leaves behind in an output.";
  metadata.scoring.hints[0].content = "Look at what the stack publishes when it finishes.";
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const templatePath = path.join(problemDir, "template.yaml");
  const template = fs
    .readFileSync(templatePath, "utf-8")
    .replace("TENKA{golden-reference-flag}", "TENKA{my-own-flag}");
  fs.writeFileSync(templatePath, template);
}

function failurePaths(result: ReturnType<typeof verifyCustomChallengePack>): string[] {
  return result.ok ? [] : result.failures.map((failure) => failure.path);
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("verifyCustomChallengePack (#2781)", () => {
  it("should reject the untouched scaffold, which only has hello-world", () => {
    const result = verifyCustomChallengePack(makePack());
    expect(result.ok).toBe(false);
    expect(failurePaths(result)).toContain("problems");
  });

  it("should reject a second problem that is still a verbatim copy of the golden challenge", () => {
    const packDir = makePack();
    addSecondProblem(packDir, "my-first-problem");
    const result = verifyCustomChallengePack(packDir);

    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.failures.map((f) => `${f.path}: ${f.message}`);
    // 題名・説明・ヒント・flag のどれも書き換えていないので、 全部指摘されること。
    expect(messages.join("\n")).toContain("custom title");
    expect(messages.join("\n")).toContain("custom description");
    expect(messages.join("\n")).toContain("customize the hint");
    expect(messages.join("\n")).toContain("golden reference flag");
  });

  it("should accept a customized second problem and print its checkpoint", () => {
    const packDir = makePack();
    customize(addSecondProblem(packDir, "my-first-problem"));

    const result = verifyCustomChallengePack(packDir);
    expect(result).toEqual({
      ok: true,
      problemId: "my-first-problem",
      problemCount: 2,
      checkpoint: "TC{CUSTOM-CHALLENGE:my-first-problem}",
    });
  });

  it("should reject replacing hello-world instead of adding alongside it", () => {
    const packDir = makePack();
    customize(addSecondProblem(packDir, "my-first-problem"));
    fs.rmSync(path.join(packDir, "problems", "challenges", "hello-world"), {
      recursive: true,
      force: true,
    });

    const result = verifyCustomChallengePack(packDir);
    expect(result.ok).toBe(false);
    expect(failurePaths(result)).toContain("problems");
  });

  it("should reject the reserved golden id even when every other field is customized", () => {
    const packDir = makePack();
    customize(addSecondProblem(packDir, "golden-basic-find-the-flag"));

    const result = verifyCustomChallengePack(packDir);
    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.failures.map((f) => f.message);
    expect(messages.join("\n")).toContain("choose your own id");
  });

  it("should reject a flagOutputKey that the template never emits", () => {
    const packDir = makePack();
    const problemDir = addSecondProblem(packDir, "my-first-problem");
    customize(problemDir);
    const metadataPath = path.join(problemDir, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    metadata.scoring.flagOutputKey = "NotAnOutput";
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const result = verifyCustomChallengePack(packDir);
    expect(result.ok).toBe(false);
    expect(failurePaths(result)).toContain(
      "problems/challenges/my-first-problem/template.yaml:Outputs",
    );
  });

  it("should surface standard pack-validator diagnostics rather than its own checks", () => {
    const packDir = makePack();
    fs.writeFileSync(path.join(packDir, "tenkacloud-pack.json"), "{}\n");

    const result = verifyCustomChallengePack(packDir);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failures.map((f) => f.message).join("\n")).toMatch(
      /\[[A-Z_]+\]/,
    );
  });

  it("should format the checkpoint the portal grades", () => {
    expect(formatCheckpoint("my-first-problem")).toBe("TC{CUSTOM-CHALLENGE:my-first-problem}");
  });
});
