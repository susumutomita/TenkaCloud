import type { Finding, Rule, RuleContext } from "../types.ts";
import { type ScannerState, step } from "./scanner.ts";

/**
 * Issue #1227: magic-number detector.
 *
 * production code (= `infrastructure/lib/`、 `apps/<spa>/src/`、 `packages/<pkg>/src/`) で
 * 意味の読めない数値リテラルを検出する。 grep / lint で意図 (= 200 vs 202、 60_000 ms vs
 * 60 個 retry) を区別できなくなる antipattern。
 *
 * 検出対象:
 *   - HTTP status code: 100..599 の整数。 `StatusCodes.*` (= `http-status-codes`) を使うべき
 *   - timeout / ms: 30_000 等 「ms らしい」 値、 timeout/delay/interval/sleep/ttl/retry hint
 *   - port: 80 / 443 / 3000 / 5173 / 5174 / 5175 / 8080 / 8443 (port / url / listen hint)
 *
 * 除外:
 *   - `0` / `1` / `2` / `-1` / `10` / `100` / `1000` (= 普通の小数)
 *   - test file (`*.test.ts(x)`)、 generated / dist / cdk.out
 *   - 文字列 / コメント / template literal 内の数値
 *   - `import "..."` 行 (= path-internal の数値)
 *   - `handlers/shared/http-status.ts` (= legacy alias 定義は対象外)
 *
 * dedup: file 単位で同 (kind, value) を 1 件にまとめ、 最初の line を採用する。
 */

const INCLUDE_PATH_PREFIXES = [
  "infrastructure/lib/",
  "infrastructure/bin/",
  "apps/admin-console/src/",
  "apps/application-admin-console/src/",
  "apps/participant-portal/src/",
  "packages/portal-plugin-sdk/src/",
  "packages/trust-bridge/src/",
] as const;

const EXCLUDE_PATTERNS = [
  /\.test\.tsx?$/,
  /\/node_modules\//,
  /\/dist\//,
  /\/cdk\.out\//,
  /\/__generated__\//,
  /\/__mocks__\//,
  /\/handlers\/shared\/http-status\.ts$/,
];

const NEVER_FLAG = new Set([0, 1, 2, -1, 10, 100, 1000]);
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const TIMEOUT_VALUES = new Set([
  1_000, 2_000, 3_000, 5_000, 10_000, 15_000, 30_000, 60_000, 90_000, 120_000, 180_000, 300_000,
  600_000, 900_000, 1_800_000, 3_600_000, 86_400_000,
]);
const COMMON_PORTS = new Set([80, 443, 3000, 5173, 5174, 5175, 8080, 8443]);

const HTTP_STATUS_CONTEXT_RES = [
  /\.json\s*\([^)]*,\s*\d{3}\)/,
  /\bstatus(Code)?\s*[:=]==?\s*\d{3}\b/,
  /\bstatus(Code)?\s*:\s*\d{3}\b/,
  /\.status\s*\(\s*\d{3}\s*\)/,
  /\b(throw|return)\s+\w*\s*\(\s*\d{3}\s*[,)]/,
];
const TIMEOUT_CONTEXT_RES = [
  /(timeout|delay|interval|sleep|wait|ttl|backoff|retry|deadline|expir)/i,
  /setTimeout|setInterval/,
];
const PORT_CONTEXT_RE = /\b(port|PORT|listen|bind|endpoint|url|URL|origin)\b/;

function shouldInspect(path: string): boolean {
  if (!/\.tsx?$/.test(path)) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(path))) return false;
  return INCLUDE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export type MagicNumberKind = "http-status" | "timeout-ms" | "port";

interface Classification {
  readonly kind: MagicNumberKind;
  readonly value: number;
}

function classify(value: number, lineText: string): Classification | undefined {
  if (NEVER_FLAG.has(value)) return undefined;
  if (isHttpStatusCandidate(value) && HTTP_STATUS_CONTEXT_RES.some((re) => re.test(lineText))) {
    return { kind: "http-status", value };
  }
  if (TIMEOUT_VALUES.has(value) && TIMEOUT_CONTEXT_RES.some((re) => re.test(lineText))) {
    return { kind: "timeout-ms", value };
  }
  if (COMMON_PORTS.has(value) && PORT_CONTEXT_RE.test(lineText)) {
    return { kind: "port", value };
  }
  return undefined;
}

function isHttpStatusCandidate(value: number): boolean {
  return Number.isInteger(value) && value >= HTTP_STATUS_MIN && value <= HTTP_STATUS_MAX;
}

interface IntegerHit {
  readonly value: number;
  readonly col: number;
}

export interface LineScanResult {
  readonly ints: IntegerHit[];
  readonly nextState: ScannerState;
}

/** Walk a single line and return integer literals found in `code` positions only. */
export function extractIntegersFromLine(line: string, initialState: ScannerState): LineScanResult {
  const ints: IntegerHit[] = [];
  let i = 0;
  let state = resetLineComment(initialState);
  while (i < line.length) {
    const c = line[i] ?? "";
    const next = line[i + 1] ?? "";
    if (state === "code" && /[0-9]/.test(c)) {
      const numeric = scanNumericAt(line, i);
      if (numeric?.value !== undefined) ints.push({ value: numeric.value, col: i });
      if (numeric?.nextIndex !== undefined) {
        i = numeric.nextIndex;
        continue;
      }
    }
    if (state === "line-comment") break; // remainder of line is comment
    const s = step(c, next, state);
    state = s.state;
    i += s.consumed;
  }
  // line-comment で行末まで進んだ場合、 次行は新しい code 状態から始める。
  if (state === "line-comment") state = "code";
  return { ints, nextState: state };
}

function resetLineComment(initialState: ScannerState): ScannerState {
  // line-comment は次の \n で終端する状態だが、 line-by-line scan の本関数は \n を見ない。
  // 呼び出し元が前行の末尾で state="line-comment" のまま渡してきたら、 本関数開始時点で
  // code に戻す (= line-comment は line 境界で必ず終わる)。
  return initialState === "line-comment" ? "code" : initialState;
}

interface NumericScanResult {
  readonly nextIndex: number;
  readonly value?: number;
}

function scanNumericAt(line: string, i: number): NumericScanResult | undefined {
  const skip = consumeIdentifierIfDigitFollowsAlpha(line, i);
  if (skip > i) return { nextIndex: skip };
  const parsed = consumeNumericLiteral(line, i);
  if (!parsed) return undefined;
  return { value: parsed.value, nextIndex: parsed.end };
}

function consumeIdentifierIfDigitFollowsAlpha(line: string, i: number): number {
  const prev = i > 0 ? (line[i - 1] ?? "") : "";
  if (!/[A-Za-z_$]/.test(prev)) return i;
  let j = i;
  while (j < line.length && /[A-Za-z0-9_$]/.test(line[j] ?? "")) j += 1;
  return j;
}

interface NumericLiteral {
  readonly value: number;
  readonly end: number;
}

function consumeNumericLiteral(line: string, start: number): NumericLiteral | undefined {
  const acc = { raw: "", j: start, hasDecimal: false };
  while (acc.j < line.length && advanceNumeric(line, acc)) {
    /* loop body in advanceNumeric */
  }
  const tail = line[acc.j] ?? "";
  if (tail && /[A-Za-z_$]/.test(tail)) return undefined; // `100n` / `200px`
  const num = Number(acc.raw);
  if (!Number.isFinite(num) || !Number.isInteger(num)) return undefined;
  return { value: num, end: acc.j };
}

interface NumericAccumulator {
  raw: string;
  j: number;
  hasDecimal: boolean;
}

/** Consume the next char into `acc` if it's part of the numeric literal. Returns false at end. */
function advanceNumeric(line: string, acc: NumericAccumulator): boolean {
  const cj = line[acc.j] ?? "";
  if (/[0-9]/.test(cj)) {
    acc.raw += cj;
    acc.j += 1;
    return true;
  }
  if (cj === "_") {
    acc.j += 1; // separator allowed between digits
    return true;
  }
  if (cj === "." && !acc.hasDecimal && /[0-9]/.test(line[acc.j + 1] ?? "")) {
    acc.raw += cj;
    acc.hasDecimal = true;
    acc.j += 1;
    return true;
  }
  return false;
}

export interface MagicNumberHit {
  readonly line: number;
  readonly value: number;
  readonly kind: MagicNumberKind;
}

export function scanFile(source: string): MagicNumberHit[] {
  const hits: MagicNumberHit[] = [];
  const lines = source.split("\n");
  let state: ScannerState = "code";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isImportLine(line)) {
      if (state === "block-comment" && line.includes("*/")) state = "code";
      continue;
    }
    const { ints, nextState } = extractIntegersFromLine(line, state);
    state = nextState;
    for (const { value } of ints) {
      const c = classify(value, line);
      if (!c) continue;
      hits.push({ line: i + 1, value, kind: c.kind });
    }
  }
  return hits;
}

function isImportLine(line: string): boolean {
  return /^\s*import\s/.test(line) || /^\s*from\s+["']/.test(line);
}

export const magicNumber: Rule = {
  id: "magic-number",
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
      const seen = new Set<string>();
      for (const hit of scanFile(content)) {
        const key = `${hit.kind}:${hit.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          ruleId: "magic-number",
          severity: "warning",
          filePath: path,
          line: hit.line,
          match: key,
          message: describe(hit),
          recommendation: recommend(hit),
        });
      }
    }
    return findings;
  },
};

function describe(hit: MagicNumberHit): string {
  switch (hit.kind) {
    case "http-status":
      return `HTTP status code リテラル ${hit.value} を直接書いている (= magic number)。`;
    case "timeout-ms":
      return `タイムアウト / interval 値 ${hit.value} を直接書いている (= magic number)。`;
    case "port":
      return `port 番号 ${hit.value} を直接書いている (= magic number)。`;
  }
}

function recommend(hit: MagicNumberHit): string {
  switch (hit.kind) {
    case "http-status":
      return (
        "`StatusCodes.*` (= http-status-codes パッケージ) を使ってください。 例: " +
        "`c.json(body, StatusCodes.OK)` / `if (res.status === StatusCodes.UNAUTHORIZED) ...`。 " +
        "規約は AGENTS.md / CLAUDE.md 「HTTP status codes: no magic numbers」 参照。"
      );
    case "timeout-ms":
      return (
        "名前付き定数に抽出し、 単位 (= `_MS` / `_MINUTES`) を suffix に含めて意図を明示してください。 " +
        "例: `const POLLING_INTERVAL_MS = 30_000;`。"
      );
    case "port":
      return (
        "config / 環境変数 / 定数に抽出してください。 frontend 開発 port は `vite.config.ts` の " +
        "`server.port` で管理し、 アプリ側は import.meta.env 経由で参照。"
      );
  }
}

export const __INTERNAL = { HTTP_STATUS_MIN, HTTP_STATUS_MAX, COMMON_PORTS, TIMEOUT_VALUES };
