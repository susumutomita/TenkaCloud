/**
 * [Issue #709] The 4x4 sudoku PROVE is built on.
 *
 * ## What this replaces, and why
 *
 * PROVE used to be a Schnorr proof: exponentiate, read a challenge, respond.
 * At p = 227 it was small enough to do on paper and, on the live run, still
 * read as 「べき乗して剰余」 -- an operation performed, not an idea understood.
 * The lecture's ZK sudoku is the same claim ("I hold a solution, and I will not
 * show it to you") with the mechanism VISIBLE: relabel the numbers, hand over
 * the relabelled grid, let the judge open one row. Anyone can see that a row of
 * 1..4 in some order says nothing about which digit went where in the original.
 *
 * ## The scheme, as the game runs it
 *
 *   - Each team holds a SOLUTION `S` (one of the 288 4x4 sudoku solutions),
 *     shown in MY VAULT. Eight of its cells are published as that team's
 *     PUZZLE `P` (`CryptoBattleState.publicPuzzles`).
 *   - PROVE: the team picks a relabelling π of the digits 1..4 (a permutation)
 *     and submits `π(S)` -- every cell replaced by its relabelled digit. The
 *     work is 「4 文字の置換表を作って 16 マスに当てる」, and it is done by hand.
 *   - The judge (`reducer.ts`) holds `S`, so it checks the submission is
 *     `π(S)` for SOME bijection π, then publishes one of the twelve constraint
 *     groups -- a row, a column or a box -- of the submitted grid. Soundness
 *     is total, not probabilistic: the judge sees the whole grid. Zero
 *     knowledge holds against the OTHER teams, who see four digits in some
 *     order and a tag saying which relabelling produced them.
 *   - Reusing π is the mistake this Order exists to let a team make. Two
 *     reveals under one π carry the same tag (`fixtures.ts`'s
 *     `derivePermutationTag`), and once enough cells of one `π(S)` are public,
 *     lining them up against `P` recovers π and then `S`. That is `hunt-sudoku`
 *     -- the successor of the nonce-reuse HUNT, teaching the same 「乱数を使い
 *     回すな」 with a relabelling instead of an exponent.
 *
 * ## Browser-safe on purpose
 *
 * The Portal renders grids and permutation tables from this module, so nothing
 * here may reach Node-only code. Everything derived from the match seed (which
 * solution a team gets, which cells are given, which group the judge opens, the
 * tag on a reveal) lives in `fixtures.ts` beside the rest of the seed-derived
 * material, because `prng.ts` imports `node:crypto`.
 */

/** Side length. The digits are 1..SUDOKU_SIZE. */
export const SUDOKU_SIZE = 4;
/** Cells in a grid: SUDOKU_SIZE squared. */
export const SUDOKU_CELLS = SUDOKU_SIZE * SUDOKU_SIZE;
/** The digits, in value order. */
export const SUDOKU_DIGITS: readonly number[] = [1, 2, 3, 4];
/** How many cells of a solution are published as the team's puzzle. */
export const SUDOKU_GIVEN_COUNT = 8;

/** A full grid (16 cells, row-major, each 1..4) or a puzzle (0 = hidden). */
export type SudokuGrid = readonly number[];
/** A relabelling: `pi[v - 1]` is what the digit `v` becomes. */
export type Permutation = readonly number[];

/**
 * The twelve constraint groups -- rows 0-3, columns 4-7, boxes 8-11 -- as
 * lists of cell indices. Every group must hold each of 1..4 exactly once; the
 * judge opens exactly one of them per successful PROVE.
 */
export const CONSTRAINT_GROUPS: readonly (readonly number[])[] = (() => {
  const groups: number[][] = [];
  for (let r = 0; r < SUDOKU_SIZE; r += 1) groups.push([0, 1, 2, 3].map((c) => r * SUDOKU_SIZE + c));
  for (let c = 0; c < SUDOKU_SIZE; c += 1) groups.push([0, 1, 2, 3].map((r) => r * SUDOKU_SIZE + c));
  for (const br of [0, 2]) {
    for (const bc of [0, 2]) {
      groups.push([br * SUDOKU_SIZE + bc, br * SUDOKU_SIZE + bc + 1, (br + 1) * SUDOKU_SIZE + bc, (br + 1) * SUDOKU_SIZE + bc + 1]);
    }
  }
  return groups;
})();

export const CONSTRAINT_GROUP_COUNT = CONSTRAINT_GROUPS.length;

/** Which kind of group index `group` (0..11) names, for a label. */
export function describeGroup(group: number): { readonly kind: "row" | "column" | "box"; readonly index: number } {
  if (group < SUDOKU_SIZE) return { kind: "row", index: group };
  if (group < 2 * SUDOKU_SIZE) return { kind: "column", index: group - SUDOKU_SIZE };
  return { kind: "box", index: group - 2 * SUDOKU_SIZE };
}

/** Whether `grid` is a well-formed FULL grid: 16 integers, each 1..4. */
export function isFullGridShape(grid: unknown): grid is SudokuGrid {
  return (
    Array.isArray(grid) &&
    grid.length === SUDOKU_CELLS &&
    grid.every((v) => Number.isInteger(v) && v >= 1 && v <= SUDOKU_SIZE)
  );
}

/** Whether a well-formed full grid satisfies every row, column and box. */
export function isValidSolution(grid: SudokuGrid): boolean {
  if (!isFullGridShape(grid)) return false;
  return CONSTRAINT_GROUPS.every((cells) => new Set(cells.map((i) => grid[i])).size === SUDOKU_SIZE);
}

/** Whether `pi` is a bijection on 1..4 (a real relabelling). */
export function isPermutation(pi: unknown): pi is Permutation {
  return (
    Array.isArray(pi) &&
    pi.length === SUDOKU_SIZE &&
    new Set(pi).size === SUDOKU_SIZE &&
    pi.every((v) => Number.isInteger(v) && v >= 1 && v <= SUDOKU_SIZE)
  );
}

export const IDENTITY_PERMUTATION: Permutation = [1, 2, 3, 4];

/** Every relabelling of 1..4, in a fixed order. 24 of them. */
export const ALL_PERMUTATIONS: readonly Permutation[] = (() => {
  const out: number[][] = [];
  const walk = (prefix: number[], rest: number[]) => {
    if (rest.length === 0) {
      out.push(prefix);
      return;
    }
    rest.forEach((v, i) => walk([...prefix, v], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  walk([], [...SUDOKU_DIGITS]);
  return out;
})();

/** Apply a relabelling to every cell. A 0 (hidden) cell stays 0. */
export function applyPermutation(grid: SudokuGrid, pi: Permutation): number[] {
  return grid.map((v) => (v === 0 ? 0 : (pi[v - 1] ?? 0)));
}

/**
 * The relabelling that turns `from` into `to`, if one exists.
 *
 * Reads every cell, so a grid that matches `from` on fifteen cells and not the
 * sixteenth yields `undefined` -- there is no partial credit for a proof. Used
 * by the judge to decide whether a submission is `π(S)` at all, and by the
 * projection to tell a team which relabellings it has already spent.
 */
export function permutationBetween(from: SudokuGrid, to: SudokuGrid): Permutation | undefined {
  if (from.length !== to.length) return undefined;
  const map = new Array<number>(SUDOKU_SIZE).fill(0);
  for (let i = 0; i < from.length; i += 1) {
    const a = from[i] ?? 0;
    const b = to[i] ?? 0;
    if (a === 0 || b === 0) {
      if (a !== b) return undefined;
      continue;
    }
    const seen = map[a - 1];
    if (seen === 0) map[a - 1] = b;
    else if (seen !== b) return undefined;
  }
  if (map.some((v) => v === 0)) return undefined;
  return isPermutation(map) ? map : undefined;
}

/**
 * The PART of a relabelling that `to` reveals about `from`, where `to` may
 * leave cells hidden (0). Returns the four-entry table with 0 for a digit no
 * revealed cell mentions, or `undefined` if the revealed cells contradict each
 * other (one digit sent two ways, or two digits sent to one). This is what a
 * hunter has to work with: a few opened groups of one relabelled grid, held
 * against a candidate solution.
 */
export function partialPermutationBetween(from: SudokuGrid, to: SudokuGrid): readonly number[] | undefined {
  if (from.length !== to.length) return undefined;
  const map = new Array<number>(SUDOKU_SIZE).fill(0);
  for (let i = 0; i < from.length; i += 1) {
    const a = from[i] ?? 0;
    const b = to[i] ?? 0;
    if (b === 0) continue;
    if (a === 0) return undefined;
    const seen = map[a - 1];
    if (seen === 0) map[a - 1] = b;
    else if (seen !== b) return undefined;
  }
  const targets = map.filter((v) => v !== 0);
  if (new Set(targets).size !== targets.length) return undefined;
  return map;
}

/** Same relabelling? Order-sensitive equality over the four entries. */
export function samePermutation(a: Permutation, b: Permutation): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Every 4x4 sudoku solution, enumerated by backtracking. There are exactly 288;
 * `sudoku.test.ts` pins that count, and `fixtures.ts` picks a team's solution
 * by index into this list so the choice is a pure function of the seed.
 */
export const ALL_SOLUTIONS: readonly SudokuGrid[] = (() => {
  const solutions: number[][] = [];
  const grid = new Array<number>(SUDOKU_CELLS).fill(0);
  const peersOf = CONSTRAINT_GROUPS.reduce<number[][]>((acc, cells) => {
    for (const cell of cells) {
      for (const other of cells) if (other !== cell && !(acc[cell] ??= []).includes(other)) acc[cell]?.push(other);
    }
    return acc;
  }, []);
  const fill = (cell: number) => {
    if (cell === SUDOKU_CELLS) {
      solutions.push([...grid]);
      return;
    }
    for (const digit of SUDOKU_DIGITS) {
      if ((peersOf[cell] ?? []).some((p) => grid[p] === digit)) continue;
      grid[cell] = digit;
      fill(cell + 1);
      grid[cell] = 0;
    }
  };
  fill(0);
  return solutions;
})();

/**
 * Every full grid consistent with a puzzle (0 = hidden). Bounded by 288, so
 * counting is cheap; the tests use it to record how often eight givens pin a
 * unique solution, and a hunter can use the same reasoning by hand.
 */
export function solutionsConsistentWith(puzzle: SudokuGrid): readonly SudokuGrid[] {
  return ALL_SOLUTIONS.filter((s) => puzzle.every((v, i) => v === 0 || v === s[i]));
}

/** One opened group of a relabelled grid, as the ledger publishes it. */
export interface OpenedGroup {
  readonly group: number;
  readonly cells: readonly number[];
}

/**
 * [Issue #709] Every solution the public record still allows, given a team's
 * puzzle and some opened groups of ONE relabelled copy of its solution.
 *
 * This is the whole sudoku HUNT, stated once: the union of the opened cells is
 * a partial view of `π(S)`; a candidate `S'` survives when the puzzle allows it
 * and SOME consistent, injective table sends its digits to what was opened.
 * The judge uses it to decide whether the record has actually given the
 * solution away before it lets anyone HUNT on it (a repeated tag alone is not
 * enough -- two reveals of the SAME group say nothing new); the playtest
 * builder and a hunter on paper do the same reasoning.
 */
export function recoverableSolutions(
  puzzle: SudokuGrid,
  opened: readonly OpenedGroup[],
): readonly SudokuGrid[] {
  const relabelled = new Array<number>(SUDOKU_CELLS).fill(0);
  for (const reveal of opened) {
    (CONSTRAINT_GROUPS[reveal.group] ?? []).forEach((cell, at) => {
      relabelled[cell] = reveal.cells[at] ?? 0;
    });
  }
  return solutionsConsistentWith(puzzle).filter(
    (candidate) => partialPermutationBetween(candidate, relabelled) !== undefined,
  );
}

/**
 * Whether `grid` agrees with `puzzle` under SOME relabelling: cells the puzzle
 * shows as equal are equal in the grid, and cells it shows as different are
 * different. This is what a verifier WITHOUT the solution can check -- it is
 * stated here so the rule is one function, though the judge in this Battle
 * checks the stronger `permutationBetween(S, grid)` because it holds `S`.
 */
export function consistentUnderRelabelling(puzzle: SudokuGrid, grid: SudokuGrid): boolean {
  const map = new Map<number, number>();
  const used = new Set<number>();
  for (let i = 0; i < puzzle.length; i += 1) {
    const given = puzzle[i] ?? 0;
    if (given === 0) continue;
    const shown = grid[i] ?? 0;
    const prior = map.get(given);
    if (prior === undefined) {
      if (used.has(shown)) return false;
      map.set(given, shown);
      used.add(shown);
    } else if (prior !== shown) return false;
  }
  return true;
}

/** `grid` rendered as four space-separated rows, for logs and tests. */
export function formatGrid(grid: SudokuGrid): string {
  const rows: string[] = [];
  for (let r = 0; r < SUDOKU_SIZE; r += 1) {
    rows.push(grid.slice(r * SUDOKU_SIZE, (r + 1) * SUDOKU_SIZE).map((v) => (v === 0 ? "." : String(v))).join(" "));
  }
  return rows.join(" / ");
}
