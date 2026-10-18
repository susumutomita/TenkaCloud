/**
 * Deterministic derivation of everything a match needs from a single seed
 * string: per-team secrets, Shamir coefficients, and the LEAK contract
 * schedule. All of it goes through prng.ts's SHA-256 counter stream -- see
 * that file for why (purity contract for the whole reducer).
 *
 * Field-space params here (`FieldConfig.prime`) stay `bigint`, deliberately
 * decoupled from `CryptoBattleConfig.prime` (a stringified bigint -- see
 * types.ts's "JSON-SAFETY INVARIANT"): this module is one of `game/src`'s
 * pure crypto modules, not a state/op boundary, so it keeps working directly
 * in `bigint` the same way `field.ts` / `shamir.ts` do. `reducer.ts` is what
 * converts `CryptoBattleConfig.prime` to `bigint` before calling in here.
 */

import { type CipherKey, type CipherRung, rungSpec } from "./ladder.ts";
import type { RotorPositions } from "./rotor.ts";
import { inv } from "./field.ts";
import { deriveBigInt, deriveBytes, deriveStream } from "./prng.ts";
import { share, type Share } from "./shamir.ts";
import type { PrivacyConstraint } from "./methods.ts";
import {
  ALL_SOLUTIONS,
  CONSTRAINT_GROUP_COUNT,
  type Permutation,
  SUDOKU_CELLS,
  SUDOKU_GIVEN_COUNT,
  type SudokuGrid,
} from "./sudoku.ts";
import type { ContractKind, OrderTaskKind } from "./types.ts";

/** The bigint-space subset of `CryptoBattleConfig` this module's derivations need. */
export interface FieldConfig {
  readonly prime: bigint;
  readonly threshold: number;
  readonly shareCount: number;
}

/** This team's secret for this generation, as a field element. */
export function deriveSecret(seed: string, teamId: string, generation: number, p: bigint): bigint {
  return deriveBigInt(seed, `secret:${teamId}:${generation}`, generation, p);
}

/** Finite teaching examples, not a secure key space. Kept off the participant bundle. */
export const RSA_PARAMETERS = [[3, 11, 3], [5, 11, 3], [5, 13, 5], [7, 11, 7]] as const;

export function deriveRsaKey(seed: string, teamId: string, generation: number) {
  const index = Number(deriveBigInt(seed, `rsa-key:${teamId}:${generation}`, 0, BigInt(RSA_PARAMETERS.length)));
  const [p, q, e] = RSA_PARAMETERS[index]!;
  return { n: p * q, e, p, q, d: Number(inv(BigInt(e), BigInt((p - 1) * (q - 1)))) };
}

export function deriveRsaPlaintext(seed: string, contractId: string): number {
  return 2 + Number(deriveBigInt(seed, `rsa-plaintext:${contractId}`, 0, 8n));
}

/** Independent generation key: neither additive shifts nor RSA parameters. */
export function deriveRotorPositions(seed: string, teamId: string, generation: number): RotorPositions {
  const [a, b] = deriveStream(seed, `rotor-key:${teamId}:${generation}`, 2, 4n);
  return { a: Number(a), b: Number(b) };
}
export function deriveRotorPlaintext(seed: string, contractId: string): readonly number[] {
  return deriveStream(seed, `rotor-plaintext:${contractId}`, 4, 4n).map(Number);
}

/** The `t - 1` Shamir polynomial coefficients (c1..c_{t-1}) for this team/generation. */
export function deriveCoefficients(
  seed: string,
  teamId: string,
  generation: number,
  threshold: number,
  p: bigint,
): bigint[] {
  return deriveStream(seed, `coeffs:${teamId}:${generation}`, threshold - 1, p);
}

/** Secret + full share set for one team's generation, derived purely from the seed. */
export function deriveTeamGeneration(
  seed: string,
  teamId: string,
  generation: number,
  config: FieldConfig,
): { readonly secret: bigint; readonly shares: readonly Share[] } {
  const secret = deriveSecret(seed, teamId, generation, config.prime);
  const coeffs = deriveCoefficients(seed, teamId, generation, config.threshold, config.prime);
  const shares = share(secret, config.threshold, config.shareCount, coeffs, config.prime);
  return { secret, shares };
}

/**
 * [Issue #659] A team's key for one rung, at one generation.
 *
 * Lives here rather than in `ladder.ts` for a boundary reason, not a taxonomy
 * one: the Portal imports `ladder.ts` to render symbols and read a rung's break
 * threshold, and anything reachable from there ends up in the SPA bundle.
 * `prng.ts` imports `node:crypto`, which a browser build cannot resolve — so
 * everything derived from the match seed stays on this side, next to
 * `deriveTeamGeneration` and `deriveContractPlan`, which are the same kind of
 * thing.
 *
 * Scoped to `generation` for the same reason the Shamir secret and the Schnorr
 * public commitment are: ROTATE has to defend the rung it is most needed on. A
 * key derived without the generation would stay broken for the rest of the
 * match, and #659 §10's 「ROTATE だけが打ち消せる」 would quietly not be true of
 * the ladder. Deriving it here means `applyRotate` covers the ladder with no
 * branch of its own — the key it hands out after a rotate is simply a different
 * one, and every pair published under the old generation stops meaning anything.
 *
 * Zero is a legal key. It is a weak one — the ciphertext equals the plaintext —
 * and a team that draws it and leaks a pair has published its key in the
 * clearest possible way. That is the rung's lesson, not a bug to design around.
 */
export function deriveCipherKey(seed: string, teamId: string, generation: number, rung: "caesar"): number;
export function deriveCipherKey(seed: string, teamId: string, generation: number, rung: CipherRung): CipherKey;
export function deriveCipherKey(
  seed: string,
  teamId: string,
  generation: number,
  rung: CipherRung,
): CipherKey {
  const spec = rungSpec(rung);
  if (rung === "vigenere") {
    return Array.from({ length: spec.keyLength }, (_, i) => Number(deriveBigInt(seed, `cipher-key:${rung}:${teamId}:${generation}:${i}`, generation) % BigInt(spec.symbols.length)));
  }
  const roll = deriveBigInt(seed, `cipher-key:${rung}:${teamId}:${generation}`, generation);
  return Number(roll % BigInt(spec.symbols.length));
}

/**
 * [Issue #659] The plaintext a ladder Order asks the team to encrypt, as symbol
 * VALUES.
 *
 * Derived from the Order's own id so two Orders never ask the same question,
 * and so a replay produces the identical belt.
 */
export function derivePlaintext(
  seed: string,
  contractId: string,
  rung: CipherRung,
): readonly number[] {
  const spec = rungSpec(rung);
  const modulus = BigInt(spec.symbols.length);
  const values: number[] = [];
  for (let position = 0; position < spec.plaintextLength; position += 1) {
    const roll = deriveBigInt(seed, `cipher-plaintext:${rung}:${contractId}`, position);
    values.push(Number(roll % modulus));
  }
  return values;
}

/**
 * [Issue #709] The 4x4 sudoku solution a team PROVEs with, at one generation.
 *
 * Picked by index into `ALL_SOLUTIONS` so the choice is a pure function of the
 * seed, and scoped to the generation for the reason every other per-team
 * secret is: ROTATE has to retire it. A team whose relabellings have all been
 * spent, or whose puzzle has been unmasked by a HUNT, rotates into a fresh
 * solution the same way it rotates into fresh shares.
 */
export function deriveSudokuSolution(seed: string, teamId: string, generation: number): SudokuGrid {
  const index = Number(
    deriveBigInt(seed, `sudoku:${teamId}:${generation}`, 0, BigInt(ALL_SOLUTIONS.length)),
  );
  const solution = ALL_SOLUTIONS[index];
  if (!solution) throw new Error(`deriveSudokuSolution: no solution at index ${index}`);
  return solution;
}

/**
 * [Issue #709] The eight cells of a team's solution that are PUBLISHED as its
 * puzzle -- `CryptoBattleState.publicPuzzles[teamId]`. Zero marks a hidden cell.
 *
 * Eight givens pin a unique solution about four times in five
 * (`sudoku.test.ts` records the measured rate). That a puzzle can sometimes be
 * SOLVED is not a weakness of the Order: ZK sudoku is about showing you hold a
 * solution without showing it, not about the puzzle being hard -- and the HUNT
 * this Order carries is gated on a MISUSE (a reused relabelling), never on
 * having solved the puzzle.
 */
export function deriveSudokuPuzzle(
  seed: string,
  teamId: string,
  generation: number,
  solution: SudokuGrid = deriveSudokuSolution(seed, teamId, generation),
): SudokuGrid {
  // A seed-driven shuffle of the cell indices; the first eight are shown.
  const order = Array.from({ length: SUDOKU_CELLS }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Number(deriveBigInt(seed, `sudoku-givens:${teamId}:${generation}`, i, BigInt(i + 1)));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  const shown = new Set(order.slice(0, SUDOKU_GIVEN_COUNT));
  return solution.map((v, i) => (shown.has(i) ? v : 0));
}

/**
 * [Issue #709] Which constraint group (0..11: rows, columns, boxes) the judge
 * opens after a successful PROVE on this Order. Bound to the Order id so a
 * team cannot learn it before submitting, and so a replay opens the same one.
 *
 * `avoid` is a list of exclusion sets, strongest preference first: the pick
 * comes from the first set that still leaves a group. The reducer passes
 * `[groups opened on this generation, groups opened under THIS relabelling's
 * tag]`: two reveals of the SAME group under one relabelling are identical
 * rows and teach a hunter nothing, so a reuse that landed on a repeated group
 * would be a mistake the record could not punish -- and the statement
 * promises that it can. Preferring a group the generation has never opened
 * makes every reuse informative for the first twelve PROVEs; past that, the
 * second tier still keeps the groups under one tag distinct until a single
 * table has been reused twelve times. Only then does the pick fall back to
 * the whole set.
 */
export function deriveRevealGroup(
  seed: string,
  contractId: string,
  avoid: readonly ReadonlySet<number>[] = [],
): number {
  const every = Array.from({ length: CONSTRAINT_GROUP_COUNT }, (_, i) => i);
  let pool = every;
  for (const excluded of avoid) {
    const candidates = every.filter((group) => !excluded.has(group));
    if (candidates.length > 0) {
      pool = candidates;
      break;
    }
  }
  const index = Number(deriveBigInt(seed, `sudoku-reveal:${contractId}`, 0, BigInt(pool.length)));
  return pool[index] ?? 0;
}

/**
 * [Issue #709] The tag a published reveal carries, naming WHICH relabelling
 * produced it without saying what that relabelling is.
 *
 * Two reveals from one team in one generation carry the same tag if and only
 * if they used the same π -- that equality is public, so a reader of the ledger
 * can see that a team reused a relabelling, the same way two Schnorr
 * transcripts sharing a commitment used to be visible. What is NOT public is π
 * itself: there are only 24, so a bare hash of π would be a lookup table, and
 * the seed in the preimage is what stops that. The judge, which holds the
 * seed, can run the 24 candidates and recover π from a tag; nobody else can.
 */
export function derivePermutationTag(
  seed: string,
  teamId: string,
  generation: number,
  pi: Permutation,
): string {
  return deriveBytes(seed, `sudoku-tag:${teamId}:${generation}:${pi.join("")}`, 0)
    .subarray(0, 6)
    .toString("hex");
}

export interface ContractPlan {
  readonly kind: ContractKind;
  /**
   * [Issue #645] What this Order asks for. `reveal-share` carries its share
   * indices; `homomorphic-sum` and `masked-total` carry public payloads that
   * `reducer.ts` derives at issuance from the match seed and the Order id, so
   * nothing about them has to live in this plan.
   */
  readonly taskKind: Exclude<OrderTaskKind, "rps-duel">;
  /** Only meaningful for a `reveal-share` task. */
  readonly requestedShareIndices: readonly number[];
  /**
   * [Issue #645] The rule this Order's client imposes on what may be published.
   *
   * A `reveal-share` Order leaves the choice open -- #645's Level-3 trade-off
   * Order (LEAK is quick and feeds the Public Ledger; PROVE costs work and
   * feeds it nothing). [Issue #709] It used to roll 1-in-4 for
   * `"no-raw-disclosure"`, the Level-1 "technique-specified" Order that PROVE
   * alone satisfies; that Order is now `zk-sudoku`, with its own slot.
   *
   * For FHE, MPC and sudoku Orders it is always `"no-raw-disclosure"`, and not
   * as a policy choice: none of those methods has any way to publish the
   * underlying value, so stating anything weaker would describe an Order that
   * does not exist.
   */
  readonly privacyConstraint: PrivacyConstraint;
  /**
   * [Issue #659] Which rung of the cipher ladder a `caesar-shift` Order sits
   * on. Undefined for every other task kind.
   */
  readonly rung?: CipherRung;
  readonly keyPosition?: number;
}

/**
 * What the `sequenceIndex`-th Order issued to `teamId` looks like: its task,
 * its kind, and the rule its client imposes. `sequenceIndex` is the count of
 * Orders already issued to that team (0-based) — callers (reducer.ts's tick())
 * derive it from `state.contracts`, so no extra counter needs to live in state.
 *
 * Roughly 1-in-5 Orders are "rush" (worth more, same mechanics). The task
 * rotates so a match reliably contains all three kinds rather than depending on
 * a roll: #645's learning progression only works if a participant actually
 * meets an FHE Order and an MPC Order, and a probabilistic schedule can leave a
 * short match with neither. Deterministic rotation also keeps a replay honest.
 *
 * Every task kind takes one slot of six: the share Order (the one with a
 * genuine LEAK / PROVE choice, #645's Level-3 Order), the cipher ladder, FHE,
 * the ZK sudoku proof, MPC, and [Issue #740] the disclosure Order -- a share
 * Order whose client is buying the share itself, so LEAK is the only answer.
 * Its share index steps through 1..shareCount on consecutive disclosures, so
 * three of them on one generation are three DISTINCT indices: the threshold.
 * A team that keeps its generation through three disclosures is huntable by
 * rule, not by mistake; ROTATE before the third is the way out, and it costs
 * the Orders still open. That is the decision the live run said the match was
 * missing.
 */
export function deriveContractPlan(
  seed: string,
  teamId: string,
  sequenceIndex: number,
  config: Pick<FieldConfig, "prime" | "shareCount">,
  progression?: { readonly elapsedMs: number; readonly buildToPressureMs: number; readonly pressureToEndgameMs?: number },
): ContractPlan {
  const RUSH_MODULUS = 5n;
  // [Issue #659 §13] The ladder Order takes a slot in the rotation rather than
  // replacing anything: #645's three tasks each teach something the ladder does
  // not, and the ladder teaches the thing none of them do -- how much you can
  // publish before your key is gone. A team meets all four in the first five
  // Orders, which is what makes the comparison between them available at all.
  // [Issue #709] The share Order held two of the five slots -- one open to
  // LEAK or PROVE, one PROVE-only -- and the live run measured it at 45% of
  // the belt. The PROVE-only slot is now the ZK sudoku Order outright: same
  // proof, stated as its own job, so a team meets the relabelling once per
  // rotation rather than only when a share Order happens to forbid LEAK.
  const TASK_ROTATION: readonly { readonly taskKind: Exclude<OrderTaskKind, "rps-duel">; readonly mustDisclose?: true }[] = [
    { taskKind: "reveal-share" },
    { taskKind: "caesar-shift" },
    { taskKind: "homomorphic-sum" },
    { taskKind: "zk-sudoku" },
    { taskKind: "masked-total" },
  ];
  // [Issue #689] The very first Order is fixed, for every team and every seed.
  //
  // START used to hand over six Orders at once, spanning LEAK / PROVE / CIPHER /
  // FHE / MPC, and a first-time player had no way to pick a first move out of
  // that. This one has a single correct action — press LEAK — so the loop
  // "an Order arrives, you choose, you press, the score moves" is learned in one
  // round trip before the belt turns into a contest.
  //
  // Both the rush roll and the privacy roll are skipped rather than reused: a
  // rush deadline would put the shortest clock on the least experienced move,
  // and `no-raw-disclosure` would forbid the very button this Order exists to
  // teach.
  if (sequenceIndex === 0) {
    const firstIndexRoll = deriveBigInt(seed, `contract-index:${teamId}`, 0, config.prime);
    return {
      kind: "standard",
      taskKind: "reveal-share",
      requestedShareIndices: [Number(firstIndexRoll % BigInt(config.shareCount)) + 1],
      privacyConstraint: "none",
    };
  }
  const kindRoll = deriveBigInt(seed, `contract-kind:${teamId}`, sequenceIndex, config.prime);
  const kind: ContractKind = kindRoll % RUSH_MODULUS === 0n ? "rush" : "standard";
  const indexRoll = deriveBigInt(seed, `contract-index:${teamId}`, sequenceIndex, config.prime);
  const slot = TASK_ROTATION[sequenceIndex % TASK_ROTATION.length] ?? { taskKind: "reveal-share" as const };
  // Alternate the existing share slot; keep cipher/Rotor/RSA issuance unchanged.
  const cycle = Math.floor(sequenceIndex / TASK_ROTATION.length);
  const mustDisclose = slot.taskKind === "reveal-share" && cycle % 2 === 1;
  // [Issue #740] A disclosure names the next index in 1..shareCount, counted
  // per cycle, so consecutive disclosures never repeat an index: the k-th
  // disclosure on a generation is the k-th distinct share out. A free share
  // Order keeps its seeded roll.
  const shareIndex = mustDisclose
    ? (Math.floor(cycle / 2) % config.shareCount) + 1
    : Number(indexRoll % BigInt(config.shareCount)) + 1;
  const taskKind = slot.taskKind === "caesar-shift" && kind === "standard" && progression?.pressureToEndgameMs !== undefined
    && progression.elapsedMs >= progression.pressureToEndgameMs ? "rsa-encrypt"
    : slot.taskKind === "caesar-shift" && kind === "standard" && progression !== undefined
      && progression.elapsedMs >= progression.buildToPressureMs && Math.floor(sequenceIndex / TASK_ROTATION.length) % 2 === 1
      ? "rotor-encrypt" : slot.taskKind;
  // FHE, MPC and the sudoku proof publish nothing reconstructable by
  // construction, so their Orders state that rule rather than rolling for it.
  // [Issue #659] A ladder Order never forbids disclosure. The decision it puts
  // in front of a team -- compute it, or publish the pair and hope your rung
  // survives -- only exists while LEAK is genuinely on the table, and an Order
  // that removed it would be a hand calculation with no choice attached.
  // [Issue #709] The share Order is always the open one now: its PROVE-only
  // variant became the `zk-sudoku` slot in the rotation above, so the privacy
  // roll it used to make has nothing left to decide.
  const privacyConstraint: PrivacyConstraint = mustDisclose
    ? "must-disclose"
    : taskKind === "rotor-encrypt" || taskKind === "rsa-encrypt" || taskKind === "caesar-shift" || taskKind === "reveal-share"
      ? "none"
      : "no-raw-disclosure";
  return {
    kind,
    taskKind,
    requestedShareIndices: [shareIndex],
    privacyConstraint,
    // #661 adopted time-based progression. Use the scheduled issue time,
    // never the delayed caller's current phase. Existing Orders keep their rung.
    ...(taskKind === "caesar-shift" ? progression !== undefined && progression.elapsedMs >= progression.buildToPressureMs
      ? { rung: "vigenere" as const, keyPosition: Math.floor(sequenceIndex / TASK_ROTATION.length) % 3 }
      : { rung: "caesar" as const } : {}),
  };
}
