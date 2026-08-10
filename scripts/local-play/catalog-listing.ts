import { createNativeCompatibilityGate } from "./native-compatibility";

/**
 * [#3008] Text presentation for `tenkacloud local list`.
 *
 * Lives here rather than in the CLI because `scripts/tenkacloud-local.ts` is "command
 * routing + composition only" by its own stated design, with each concern layer under
 * `local-play/`. Adding the host-compatibility marking inline pushed that file past the
 * harness's 800-line SRP limit, which is the limit doing its job: formatting a catalog
 * listing is a concern, not routing.
 */

/** The fields this module needs from a listing row; a structural subset of the summary. */
export interface ListedProblem {
  readonly problemId: string;
  readonly name: string;
  readonly category: string;
  readonly compatibility?: {
    readonly nativeArchitectures?: readonly string[];
    readonly cpuFlags?: readonly string[];
  };
}

/** Column widths that fit every row plus the header labels. */
export function listingColumnWidths(problems: readonly ListedProblem[]): {
  readonly idWidth: number;
  readonly categoryWidth: number;
} {
  return {
    idWidth: Math.max(...problems.map((p) => p.problemId.length), "id".length),
    categoryWidth: Math.max(...problems.map((p) => p.category.length), "category".length),
  };
}

/**
 * Render the local-play rows, marking any problem whose declared `runtime.compatibility`
 * this machine cannot satisfy and explaining each refusal in both languages afterwards.
 *
 * An unsupported problem is still listed. Hiding it would look identical to a problem that
 * was never authored, and the participant would have no way to learn that their machine is
 * the reason — the same argument that keeps AWS-only problems in the catalog with a badge.
 *
 * Returns the lines instead of printing them so the formatting is testable without
 * capturing stdout.
 */
export function formatLocalProblemListing(
  problems: readonly ListedProblem[],
  compatibilityOf = createNativeCompatibilityGate(
    (problemId) => problems.find((p) => p.problemId === problemId)?.compatibility,
  ),
): readonly string[] {
  const { idWidth, categoryWidth } = listingColumnWidths(problems);
  const rows: string[] = [`  ${"id".padEnd(idWidth)}  ${"category".padEnd(categoryWidth)}  name`];
  const refusals: string[] = [];
  for (const problem of problems) {
    const verdict = compatibilityOf(problem.problemId);
    const mark = verdict.supported ? "" : "  [not startable on this machine]";
    if (!verdict.supported) {
      refusals.push(
        `  ${problem.problemId}: ${verdict.message}`,
        `  ${problem.problemId}: ${verdict.messageJa}`,
      );
    }
    rows.push(
      `  ${problem.problemId.padEnd(idWidth)}  ${problem.category.padEnd(categoryWidth)}  ${problem.name}${mark}`,
    );
  }
  return refusals.length > 0 ? [...rows, "", ...refusals] : rows;
}
