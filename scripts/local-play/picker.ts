import type { LocalPlayProblemSummary } from "./manifest";

/**
 * Issue #2188: `make local` without an explicit `PROBLEM=` used to silently
 * default to sqli-demo, which players didn't notice they were even playing.
 * When the run is interactive, the top-level target now prompts with this
 * numbered menu (rendered to stderr) and captures the choice. Pure so the
 * formatting is unit-tested; the stdin/stdout wiring lives in tenkacloud-local's
 * `pick` command.
 */
export function renderProblemMenu(summaries: readonly LocalPlayProblemSummary[]): string {
  const numberWidth = String(summaries.length).length;
  const idWidth = Math.max(...summaries.map((s) => s.problemId.length));
  const lines = summaries.map((s, i) => {
    const marker = `${String(i + 1).padStart(numberWidth)})`;
    return `  ${marker} ${s.problemId.padEnd(idWidth)}  ${s.name}`;
  });
  return ["Choose a problem to play locally:", "", ...lines].join("\n");
}

/**
 * Resolve a raw selection line (a 1-based menu number or a problem id) to a
 * problemId. Returns undefined for empty / out-of-range / unknown input so the
 * caller can re-prompt. It never silently substitutes a default — surfacing the
 * choice is the whole point of the prompt (#2188).
 */
export function resolveProblemSelection(
  rawInput: string,
  summaries: readonly LocalPlayProblemSummary[],
): string | undefined {
  const input = rawInput.trim();
  if (input.length === 0) return undefined;
  if (/^\d+$/.test(input)) {
    return summaries[Number(input) - 1]?.problemId;
  }
  return summaries.find((s) => s.problemId === input)?.problemId;
}
