import { appendFileSync } from "node:fs";

export type SuspiciousCommentDetection =
  | { suspicious: false }
  | {
      suspicious: true;
      reasons: string[];
      matchedPatterns: string[];
    };

export type SuspiciousCommentDecision =
  | {
      suspicious: false;
      skipped: true;
      skipReason: "bot-author" | "trusted-author";
    }
  | {
      suspicious: false;
      skipped: false;
    }
  | {
      suspicious: true;
      skipped: false;
      reasons: string[];
      matchedPatterns: string[];
    };

export interface SuspiciousCommentContext {
  readonly body: string;
  readonly authorAssociation?: string;
  readonly authorLogin?: string;
  readonly authorType?: string;
  readonly commentUrl?: string;
}

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const ATTACHMENT_URL_PATTERNS = [
  "private-user-images.githubusercontent.com",
  "github.com/user-attachments/assets/",
] as const;

const ARCHIVE_AND_EXECUTABLE_EXTENSIONS = [
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
] as const;

const PATCH_EXTENSIONS = [".patch", ".diff"] as const;
const PATCH_TOKENS = ["repository_patch", "patch_v2"] as const;

const WEAK_SIGNAL_PHRASES = ["download", "extract", "apply this patch", "works smoother"] as const;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isWordCharacter(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "_"
  );
}

function includesWord(text: string, word: string): boolean {
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(word, cursor);
    if (index === -1) return false;
    const before = text[index - 1];
    const after = text[index + word.length];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    cursor = index + word.length;
  }
  return false;
}

function matchingPatterns(text: string, patterns: readonly string[], prefix: string): string[] {
  return patterns
    .filter((pattern) => text.includes(pattern))
    .map((pattern) => `${prefix}:${pattern}`);
}

export function detectSuspiciousComment(body: string): SuspiciousCommentDetection {
  const text = body.toLowerCase();
  const attachmentMatches = matchingPatterns(text, ATTACHMENT_URL_PATTERNS, "attachment-url");
  const archiveOrExecutableMatches = matchingPatterns(
    text,
    ARCHIVE_AND_EXECUTABLE_EXTENSIONS,
    "file-extension",
  );
  const patchExtensionMatches = matchingPatterns(text, PATCH_EXTENSIONS, "patch-file-extension");
  const patchTokenMatches = matchingPatterns(text, PATCH_TOKENS, "patch-token");
  const weakPhraseMatches = WEAK_SIGNAL_PHRASES.filter((phrase) => text.includes(phrase));
  const hasRunWord = includesWord(text, "run");

  const strongReasons: string[] = [];
  const strongMatchedPatterns: string[] = [];

  if (attachmentMatches.length > 0 && archiveOrExecutableMatches.length > 0) {
    strongReasons.push("GitHub attachment URL is paired with an archive or executable extension.");
    strongMatchedPatterns.push(...attachmentMatches, ...archiveOrExecutableMatches);
  }

  // "download this fix.zip and run it" — the classic lure carries an archive/executable
  // extension plus a social-engineering verb even when the file is hosted OFF GitHub
  // (no attachment URL). The extension alone stays silent (legit build-artifact talk),
  // but paired with a lure phrase it is a strong signal.
  if (archiveOrExecutableMatches.length > 0 && (weakPhraseMatches.length > 0 || hasRunWord)) {
    strongReasons.push(
      "Archive or executable extension is paired with a social-engineering phrase.",
    );
    strongMatchedPatterns.push(...archiveOrExecutableMatches);
  }

  if (patchExtensionMatches.length > 0) {
    strongReasons.push("Patch or diff file extension is referenced in an issue comment.");
    strongMatchedPatterns.push(...patchExtensionMatches);
  }

  if (patchTokenMatches.length > 0) {
    strongReasons.push("Repository patch token is referenced in an issue comment.");
    strongMatchedPatterns.push(...patchTokenMatches);
  }

  if (strongReasons.length === 0) {
    return { suspicious: false };
  }

  const weakReasons: string[] = [];
  const weakMatchedPatterns: string[] = [];
  for (const phrase of weakPhraseMatches) {
    weakReasons.push(`Weak social-engineering phrase appears with a strong signal: ${phrase}.`);
    weakMatchedPatterns.push(`weak-phrase:${phrase}`);
  }
  if (hasRunWord) {
    weakReasons.push("Weak social-engineering phrase appears with a strong signal: run.");
    weakMatchedPatterns.push("weak-word:run");
  }

  return {
    suspicious: true,
    reasons: unique([...strongReasons, ...weakReasons]),
    matchedPatterns: unique([...strongMatchedPatterns, ...weakMatchedPatterns]),
  };
}

export function evaluateSuspiciousComment(
  context: SuspiciousCommentContext,
): SuspiciousCommentDecision {
  const authorType = context.authorType?.toLowerCase();
  const authorLogin = context.authorLogin?.toLowerCase();
  if (authorType === "bot" || authorLogin === "github-actions[bot]") {
    return { suspicious: false, skipped: true, skipReason: "bot-author" };
  }

  const authorAssociation = context.authorAssociation?.toUpperCase();
  if (authorAssociation && TRUSTED_AUTHOR_ASSOCIATIONS.has(authorAssociation)) {
    return { suspicious: false, skipped: true, skipReason: "trusted-author" };
  }

  const detection = detectSuspiciousComment(context.body);
  if (!detection.suspicious) return { suspicious: false, skipped: false };
  return { suspicious: true, skipped: false, ...detection };
}

function outputLine(name: string, value: string): string {
  return `${name}=${value.replaceAll("\n", " ")}\n`;
}

function appendGithubOutput(
  values: Record<string, string>,
  outputPath = process.env.GITHUB_OUTPUT,
): void {
  const body = Object.entries(values)
    .map(([name, value]) => outputLine(name, value))
    .join("");
  if (outputPath) {
    appendFileSync(outputPath, body);
  } else {
    process.stdout.write(body);
  }
}

function appendSummary(
  decision: SuspiciousCommentDecision,
  commentUrl: string | undefined,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
): void {
  if (!decision.suspicious) return;
  if (!summaryPath) return;

  const lines = [
    "## Suspicious comment detected",
    "",
    commentUrl ? `Comment: ${commentUrl}` : undefined,
    "",
    "Reasons:",
    ...decision.reasons.map((reason) => `- ${reason}`),
    "",
    "Matched patterns:",
    ...decision.matchedPatterns.map((pattern) => `- ${pattern}`),
    "",
  ].filter((line): line is string => line !== undefined);

  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

export function runCli(env: NodeJS.ProcessEnv = process.env): SuspiciousCommentDecision {
  const decision = evaluateSuspiciousComment({
    body: env.COMMENT_BODY ?? "",
    authorAssociation: env.COMMENT_AUTHOR_ASSOCIATION,
    authorLogin: env.COMMENT_AUTHOR_LOGIN,
    authorType: env.COMMENT_AUTHOR_TYPE,
    commentUrl: env.COMMENT_URL,
  });

  appendGithubOutput(
    {
      suspicious: decision.suspicious ? "true" : "false",
      skipped: decision.skipped ? "true" : "false",
      skip_reason: decision.skipped ? decision.skipReason : "",
      reasons_json: decision.suspicious ? JSON.stringify(decision.reasons) : "[]",
      matched_patterns_json: decision.suspicious ? JSON.stringify(decision.matchedPatterns) : "[]",
    },
    env.GITHUB_OUTPUT,
  );
  appendSummary(decision, env.COMMENT_URL, env.GITHUB_STEP_SUMMARY);

  return decision;
}

if (import.meta.main) {
  runCli();
}
