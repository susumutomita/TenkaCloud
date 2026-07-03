import type { Finding, RuleContext, Severity } from "./types.ts";

/**
 * Issue #2218: single implementation of the per-line regex scan idiom that every
 * line-based rule under `src/rules/` was copying (shouldInspect filter → `ctx.files`
 * loop → `readFile` try/catch → `split("\n")` → per-line regex → Finding push).
 *
 * Consolidating it removes ~10 near-identical copies and, crucially, makes the
 * *comment-skipping* behaviour a single per-rule switch instead of a divergent,
 * copy-pasted state machine — `handler-must-not-call-fetch` carried a block/line
 * comment stripper while `secrets-manager-forbidden` did not, so identical-looking
 * rules disagreed on whether a commented-out `import` is a hit.
 *
 * This helper does NOT change any rule's detection: each migrated rule passes the
 * exact `shouldInspect`, `lineRegex`, and `stripComments` value it already had, and
 * the existing rule tests lock that behaviour. (Aligning `secrets-manager-forbidden`
 * onto comment-stripping is a deliberate behaviour change and is handled separately
 * per the issue, not smuggled in here.)
 *
 * Only rules that split on `"\n"` and emit one finding per matching line migrate
 * here; the `\r?\n` / first-match-only scanners keep their own loops for now.
 */

/** Matches a line that is a `//` line comment, a `*` JSDoc continuation, or an opening `/*`. */
const LINE_COMMENT_RE = /^\s*(\/\/|\*|\/\*)/;
const BLOCK_COMMENT_OPEN_RE = /\/\*/;
const BLOCK_COMMENT_CLOSE_RE = /\*\//;

export interface ScanLinesOptions {
  readonly ruleId: string;
  readonly severity: Severity;
  /** Repo-relative path predicate; only matching files are read and scanned. */
  readonly shouldInspect: (path: string) => boolean;
  /** Fast per-line test. Must not carry the `g` flag (stateful `lastIndex`). */
  readonly lineRegex: RegExp;
  /**
   * When true, lines inside `/* ... *\/` blocks and `//` / `*` / `/*` comment lines
   * are skipped before the regex test — the same simple state machine
   * `handler-must-not-call-fetch` used. Defaults to false (scan every non-empty line).
   */
  readonly stripComments?: boolean;
  /**
   * Builds the rule-specific fields for a matching line. The helper supplies
   * `ruleId` / `severity` / `filePath` / `line`; the rule returns the rest.
   */
  readonly buildFinding: (args: {
    readonly path: string;
    readonly lineNumber: number;
    readonly line: string;
  }) => Pick<Finding, "match" | "message" | "recommendation">;
}

/**
 * Track the block-comment state line by line. Returns whether the line should be
 * skipped (it is inside or is a comment) and the next `inBlockComment` state. This
 * is the exact simple state machine `handler-must-not-call-fetch` carried inline —
 * it does not parse strings, only `/*`/`*\/`/`//` at line granularity.
 */
function stepCommentState(
  line: string,
  inBlockComment: boolean,
): { skip: boolean; inBlockComment: boolean } {
  if (inBlockComment) {
    return { skip: true, inBlockComment: !BLOCK_COMMENT_CLOSE_RE.test(line) };
  }
  const opensUnclosedBlock = BLOCK_COMMENT_OPEN_RE.test(line) && !BLOCK_COMMENT_CLOSE_RE.test(line);
  const skip = LINE_COMMENT_RE.test(line);
  return { skip, inBlockComment: opensUnclosedBlock };
}

/** Scan one already-read file, appending a Finding per matching (non-skipped) line. */
function scanFileLines(path: string, content: string, opts: ScanLinesOptions): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (opts.stripComments) {
      const state = stepCommentState(line, inBlockComment);
      inBlockComment = state.inBlockComment;
      if (state.skip) continue;
    }
    if (!opts.lineRegex.test(line)) continue;
    findings.push({
      ruleId: opts.ruleId,
      severity: opts.severity,
      filePath: path,
      line: i + 1,
      ...opts.buildFinding({ path, lineNumber: i + 1, line }),
    });
  }
  return findings;
}

/** Run one line-regex rule over `ctx.files`, returning one Finding per matching line. */
export function scanLinesByRegex(ctx: RuleContext, opts: ScanLinesOptions): Finding[] {
  const findings: Finding[] = [];
  for (const path of ctx.files) {
    if (!opts.shouldInspect(path)) continue;
    let content: string;
    try {
      content = ctx.readFile(path);
    } catch {
      // Unreadable file (deleted / binary): skip, matching every rule's prior behaviour.
      continue;
    }
    findings.push(...scanFileLines(path, content, opts));
  }
  return findings;
}
