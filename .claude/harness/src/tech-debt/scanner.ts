/**
 * Shared TypeScript source scanner state for the tech-debt rule parsers.
 *
 * The scanner tracks whether the current position is inside:
 *   - code             (default)
 *   - sq / dq / bt     single-quote / double-quote / backtick string literal
 *   - line-comment     `//` until newline
 *   - block-comment    `/` `*` ... `*` `/`
 *
 * Each step accepts the current `(char, nextChar)` and returns the next state and
 * how many characters were consumed. Callers iterate manually so they can also
 * count tokens (= expect / digit / paren) while staying inside `state === "code"`.
 *
 * Centralising the state machine here keeps each rule under biome's
 * `noExcessiveCognitiveComplexity` threshold (= 15) without sacrificing the
 * literal/comment awareness needed to avoid false positives.
 */

export type ScannerState = "code" | "sq" | "dq" | "bt" | "line-comment" | "block-comment";

export interface ScanStep {
  readonly state: ScannerState;
  readonly consumed: number;
}

/**
 * Advance the scanner one step. Returns the next state and how many input chars to
 * consume. Caller is expected to be in `state === "code"` when interpreting
 * tokens (= identifiers, parens, numeric literals).
 */
export function step(c: string, next: string, state: ScannerState): ScanStep {
  if (state === "code") return stepCode(c, next);
  if (state === "line-comment") return c === "\n" ? toCode(1) : same(state, 1);
  if (state === "block-comment") {
    if (c === "*" && next === "/") return toCode(2);
    return same(state, 1);
  }
  // string-like states share the escape + close-quote rule
  return stepString(c, state);
}

function stepCode(c: string, next: string): ScanStep {
  if (c === "/" && next === "/") return { state: "line-comment", consumed: 2 };
  if (c === "/" && next === "*") return { state: "block-comment", consumed: 2 };
  if (c === '"') return { state: "dq", consumed: 1 };
  if (c === "'") return { state: "sq", consumed: 1 };
  if (c === "`") return { state: "bt", consumed: 1 };
  return same("code", 1);
}

function stepString(c: string, state: ScannerState): ScanStep {
  if (c === "\\") return same(state, 2); // skip the escaped char
  if (state === "dq" && c === '"') return toCode(1);
  if (state === "sq" && c === "'") return toCode(1);
  if (state === "bt" && c === "`") return toCode(1);
  return same(state, 1);
}

function toCode(consumed: number): ScanStep {
  return { state: "code", consumed };
}

function same(state: ScannerState, consumed: number): ScanStep {
  return { state, consumed };
}
