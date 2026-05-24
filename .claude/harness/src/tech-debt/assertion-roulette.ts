import type { Finding, Rule, RuleContext } from "../types.ts";
import { type ScannerState, step } from "./scanner.ts";

/**
 * Issue #1227: assertion-roulette detector.
 *
 * 1 つの test case (= `it(...)` / `test(...)`) 内で `expect(...)` を 6 個以上呼んでいるテストは
 * 落ちたときどの assertion で死んだのかが読み取りにくい (= "assertion roulette" smell, xUnit
 * Test Patterns)。
 *
 * 検出条件:
 *   - test file (`*.test.ts` / `*.test.tsx`)
 *   - `it(...)` または `test(...)` ブロック内の `expect(...)` を数える
 *   - **6 個以上** で warning
 *
 * 改善方針:
 *   - 1 it = 1 振る舞いの assertion に絞り、 別 case を `it("should ...")` で増やす
 *   - 共通 setup は `beforeEach` に移す
 *   - 複数 assertion を残すなら `expect(actual, "context message").toBe(...)` のように
 *     第 2 引数で文脈を与える (Vitest はサポート)
 *
 * match は bucket (= 6-10 / 11-20 / 20+) にして 1 個増減で baseline が外れないようにする。
 */

const EXPECT_THRESHOLD = 6;

const TEST_FILE_RE = /\.test\.tsx?$/;
const EXCLUDE_PATTERNS = [/\/node_modules\//, /\/dist\//, /\/cdk\.out\//, /\/__generated__\//];

const IT_BLOCK_RE = /\b(it|test)\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;

function shouldInspect(path: string): boolean {
  if (!TEST_FILE_RE.test(path)) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(path))) return false;
  return true;
}

function bucket(count: number): string {
  if (count >= 21) return "ge-21-expects";
  if (count >= 11) return "ge-11-expects";
  return "ge-6-expects";
}

interface Block {
  readonly name: string;
  readonly startLine: number;
  readonly body: string;
}

/**
 * Source から `it(...)` / `test(...)` ブロックを抽出する。 brace 平衡 (= `{` / `}` の depth が
 * 0 に戻る) を見て本体終端を見つけるシンプルなパーサ。 string literal / template literal / line
 * comment 内の brace は無視する (scanner.ts に集約)。
 */
export function extractBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  IT_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex iteration pattern
  while ((m = IT_BLOCK_RE.exec(source)) !== null) {
    const name = m[2] ?? m[3] ?? m[4] ?? "";
    const matchEnd = m.index + m[0].length;
    const openIdx = findCallbackBodyOpen(source, matchEnd);
    if (openIdx < 0) continue;
    const closeIdx = findMatchingBrace(source, openIdx);
    if (closeIdx < 0) continue;
    const body = source.slice(openIdx + 1, closeIdx);
    const startLine = countNewlines(source, 0, m.index) + 1;
    blocks.push({ name, startLine, body });
    IT_BLOCK_RE.lastIndex = closeIdx;
  }
  return blocks;
}

interface BodyOpenState {
  depthParen: number;
  depthBracket: number;
  sawFunction: boolean;
}

function findCallbackBodyOpen(source: string, from: number): number {
  // After `it("name"`, the rest looks like: `, () => { ... })` or `, function () { ... })`.
  // We walk forward (depthParen = 1 because we are still inside `it(`) and accept the first
  // `{` that is preceded by `=>` (arrow body) or comes after a `function` keyword we have
  // seen since `from` (function-expression body). Object-literal arguments are skipped over
  // by jumping to the matching `}`.
  const ctx: BodyOpenState = { depthParen: 1, depthBracket: 0, sawFunction: false };
  let i = from;
  let state: ScannerState = "code";
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (state === "code") {
      const res = inspectCodeChar(source, i, c, ctx);
      if (res.bodyOpenAt !== undefined) return res.bodyOpenAt;
      if (res.aborted) return -1;
      if (res.skipTo !== undefined) {
        i = res.skipTo;
        continue;
      }
    }
    const s = step(c, next, state);
    state = s.state;
    i += s.consumed;
  }
  return -1;
}

interface CodeCharResult {
  bodyOpenAt?: number;
  aborted?: boolean;
  /** When set, caller should resume scanning at this position (= jump past skipped group). */
  skipTo?: number;
}

function inspectCodeChar(source: string, i: number, c: string, ctx: BodyOpenState): CodeCharResult {
  if (c === "(") {
    ctx.depthParen += 1;
    return {};
  }
  if (c === ")") {
    ctx.depthParen -= 1;
    if (ctx.depthParen <= 0) return { aborted: true };
    return {};
  }
  if (c === "[") {
    ctx.depthBracket += 1;
    return {};
  }
  if (c === "]") {
    ctx.depthBracket -= 1;
    return {};
  }
  if (c === "{" && ctx.depthBracket === 0) {
    const back = scanBackToken(source, i - 1);
    if (back === "=>" || ctx.sawFunction) return { bodyOpenAt: i };
    const close = findMatchingBrace(source, i);
    if (close < 0) return { aborted: true };
    return { skipTo: close + 1 };
  }
  if (c === "f" && isFunctionKeyword(source, i)) {
    ctx.sawFunction = true;
  }
  return {};
}

function isFunctionKeyword(source: string, i: number): boolean {
  if (source.slice(i, i + 8) !== "function") return false;
  const prev = source[i - 1] ?? "";
  const after = source[i + 8] ?? "";
  return !/[A-Za-z0-9_$]/.test(prev) && !/[A-Za-z0-9_$]/.test(after);
}

/** Looks at the character at `idx` and reads backward, returning the "=>" token if present. */
function scanBackToken(source: string, idx: number): string {
  let i = idx;
  while (i >= 0 && /\s/.test(source[i] ?? "")) i -= 1;
  if (i < 1) return "";
  if (source[i] === ">" && source[i - 1] === "=") return "=>";
  return source[i] ?? "";
}

/** Given the position of `{`, returns the position of the matching `}`. Respects strings/comments. */
function findMatchingBrace(source: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  let state: ScannerState = "code";
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (state === "code") {
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    const s = step(c, next, state);
    state = s.state;
    i += s.consumed;
  }
  return -1;
}

function countNewlines(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i += 1) {
    if (s[i] === "\n") n += 1;
  }
  return n;
}

/** Count `expect(` occurrences outside string/comment context. */
export function countExpectCalls(body: string): number {
  let count = 0;
  let i = 0;
  let state: ScannerState = "code";
  while (i < body.length) {
    const c = body[i] ?? "";
    const next = body[i + 1] ?? "";
    if (state === "code" && isExpectCallAt(body, i)) {
      count += 1;
      i += 7; // length of "expect("
      continue;
    }
    const s = step(c, next, state);
    state = s.state;
    i += s.consumed;
  }
  return count;
}

function isExpectCallAt(body: string, i: number): boolean {
  if (body.slice(i, i + 7) !== "expect(") return false;
  // `.` excludes member calls (= obj.expect()), which are not the vitest global.
  const prev = i > 0 ? (body[i - 1] ?? "") : "";
  return !/[A-Za-z0-9_$.]/.test(prev);
}

export const assertionRoulette: Rule = {
  id: "assertion-roulette",
  severity: "warning",
  check(ctx: RuleContext): readonly Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.files) {
      if (!shouldInspect(path)) continue;
      let content: string;
      try {
        content = ctx.readFile(path);
      } catch {
        continue;
      }
      if (!/\b(it|test)\s*\(/.test(content)) continue;
      const blocks = extractBlocks(content);
      for (const block of blocks) {
        const count = countExpectCalls(block.body);
        if (count < EXPECT_THRESHOLD) continue;
        findings.push({
          ruleId: "assertion-roulette",
          severity: "warning",
          filePath: path,
          line: block.startLine,
          match: bucket(count),
          message:
            `Test case "${block.name}" は expect() を ${count} 回呼んでいる (閾値 ${EXPECT_THRESHOLD})。 ` +
            "失敗時にどの assertion で落ちたか読み取りづらい (= assertion roulette)。",
          recommendation:
            '1 it = 1 振る舞いに絞り、 別 case を `it("should ...")` で増やしてください。 共通 setup は ' +
            '`beforeEach` に集約。 複数 assertion を残す場合は `expect(actual, "context").toBe(...)` の ' +
            "ように第 2 引数で文脈を与えて失敗 message を読みやすくする。",
        });
      }
    }
    return findings;
  },
};

export const __INTERNAL = { EXPECT_THRESHOLD };
