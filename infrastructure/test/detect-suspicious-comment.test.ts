import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectSuspiciousComment,
  evaluateSuspiciousComment,
  runCli,
  type SuspiciousCommentDetection,
} from "../../scripts/security/detect-suspicious-comment";

type SuspiciousResult = Extract<SuspiciousCommentDetection, { suspicious: true }>;

function shouldBeSuspicious(body: string): SuspiciousResult {
  const result = detectSuspiciousComment(body);
  expect(result.suspicious).toBe(true);
  if (!result.suspicious) throw new Error("expected the comment to be suspicious");
  return result;
}

describe("detectSuspiciousComment (Issue #2452 suspicious issue comments)", () => {
  it("should detect archive and executable extensions when they are paired with GitHub attachment URLs", () => {
    const extensions = [
      ".zip",
      ".tar",
      ".tar.gz",
      ".tgz",
      ".7z",
      ".rar",
      ".exe",
      ".dmg",
      ".pkg",
      ".msi",
      ".sh",
      ".ps1",
    ];

    for (const extension of extensions) {
      const result = shouldBeSuspicious(
        `Please check artifact${extension} from https://github.com/user-attachments/assets/abc123`,
      );
      expect(result.matchedPatterns).toContain(`file-extension:${extension}`);
      expect(result.matchedPatterns).toContain(
        "attachment-url:github.com/user-attachments/assets/",
      );
    }
  });

  it("should detect private-user-images attachments with archive extensions", () => {
    const result = shouldBeSuspicious(
      "Download repository_patch_v2.zip from https://private-user-images.githubusercontent.com/1/2/file.zip and run it.",
    );

    expect(result.matchedPatterns).toEqual(
      expect.arrayContaining([
        "attachment-url:private-user-images.githubusercontent.com",
        "file-extension:.zip",
        "patch-token:repository_patch",
        "patch-token:patch_v2",
        "weak-phrase:download",
        "weak-word:run",
      ]),
    );
  });

  it("should detect patch and diff file extensions without requiring an attachment URL", () => {
    for (const extension of [".patch", ".diff"]) {
      const result = shouldBeSuspicious(`Please apply fix${extension}.`);
      expect(result.matchedPatterns).toContain(`patch-file-extension:${extension}`);
    }
  });

  it("should detect repository_patch and patch_v2 tokens as standalone strong signals", () => {
    for (const token of ["repository_patch", "patch_v2"]) {
      const result = shouldBeSuspicious(`This comment references ${token} for the issue.`);
      expect(result.matchedPatterns).toContain(`patch-token:${token}`);
    }
  });

  it("should add weak social-engineering reasons only when a strong signal is present", () => {
    const result = shouldBeSuspicious(
      "Please download, extract, and run fix.zip from https://github.com/user-attachments/assets/abc123. Apply this patch; it works smoother.",
    );

    expect(result.matchedPatterns).toEqual(
      expect.arrayContaining([
        "weak-phrase:download",
        "weak-phrase:extract",
        "weak-word:run",
        "weak-phrase:apply this patch",
        "weak-phrase:works smoother",
      ]),
    );
  });

  it("should flag an archive extension paired with a lure phrase even without a GitHub attachment URL", () => {
    const detection = detectSuspiciousComment(
      "I fixed it locally — download fix_bundle.zip from my mirror and run the installer.",
    );
    expect(detection.suspicious).toBe(true);
    if (detection.suspicious) {
      expect(detection.reasons).toContain(
        "Archive or executable extension is paired with a social-engineering phrase.",
      );
    }
  });

  it("should not flag weak phrases by themselves because run is common in normal comments", () => {
    expect(
      detectSuspiciousComment(
        "Could you run the tests again? It works smoother after the latest refactor.",
      ),
    ).toEqual({ suspicious: false });
  });

  it("should not flag archive extensions or attachment URLs by themselves", () => {
    expect(
      detectSuspiciousComment("The release notes mention .zip archives as an example."),
    ).toEqual({
      suspicious: false,
    });
    expect(
      detectSuspiciousComment(
        "Here is a screenshot: https://github.com/user-attachments/assets/abc123",
      ),
    ).toEqual({ suspicious: false });
  });

  it("should skip bot authors before scanning warning comments", () => {
    expect(
      evaluateSuspiciousComment({
        body: "zip patch download",
        authorLogin: "github-actions[bot]",
        authorType: "Bot",
      }),
    ).toEqual({ suspicious: false, skipped: true, skipReason: "bot-author" });
  });

  it("should skip owner, member, and collaborator comments before scanning", () => {
    for (const authorAssociation of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(
        evaluateSuspiciousComment({
          body: "Please apply fix.patch.",
          authorAssociation,
          authorLogin: "maintainer",
          authorType: "User",
        }),
      ).toEqual({ suspicious: false, skipped: true, skipReason: "trusted-author" });
    }
  });

  it("should detect the same body for external contributors", () => {
    const decision = evaluateSuspiciousComment({
      body: "Please apply fix.patch.",
      authorAssociation: "CONTRIBUTOR",
      authorLogin: "external-user",
      authorType: "User",
    });

    expect(decision.suspicious).toBe(true);
    expect(decision.skipped).toBe(false);
  });

  it("should write GitHub outputs and a Step Summary without echoing the comment body", () => {
    const workDir = mkdtempSync(join(tmpdir(), "tenkacloud-suspicious-comment-"));
    const outputPath = join(workDir, "github-output");
    const summaryPath = join(workDir, "step-summary");
    const body =
      "secret body text: download fix.zip from https://github.com/user-attachments/assets/abc123";

    const decision = runCli({
      COMMENT_BODY: body,
      COMMENT_AUTHOR_ASSOCIATION: "NONE",
      COMMENT_AUTHOR_LOGIN: "external-user",
      COMMENT_AUTHOR_TYPE: "User",
      COMMENT_URL: "https://github.com/susumutomita/TenkaCloud/issues/2452#issuecomment-1",
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    } as NodeJS.ProcessEnv);

    expect(decision.suspicious).toBe(true);
    const output = readFileSync(outputPath, "utf8");
    const summary = readFileSync(summaryPath, "utf8");
    expect(output).toContain("suspicious=true");
    expect(output).not.toContain("secret body text");
    expect(summary).toContain("Suspicious comment detected");
    expect(summary).not.toContain("secret body text");
  });
});
