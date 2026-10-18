/**
 * Issue #645 Phase 3: masked secure summation behind MPC Orders.
 *
 * An MPC Order puts a team in a room with two other offices. All three have a
 * private number. The client wants the TOTAL and is not entitled to any
 * individual figure. #645: 「各チームの値を誰にも公開せず合計だけ求めよ」.
 *
 * ## The protocol
 *
 * Every ordered pair of offices `(i, j)` with `i != j` shares a mask
 * `m[i][j]`, known only to those two. Office `j` publishes
 *
 * ```text
 * partial[j] = x[j] + (masks received by j) - (masks sent by j)   mod p
 *            = x[j] + SUM_{i != j} m[i][j] - SUM_{i != j} m[j][i]
 * ```
 *
 * Every mask appears exactly twice across the three partials, once added and
 * once subtracted, so they cancel:
 *
 * ```text
 * partial[0] + partial[1] + partial[2] = x[0] + x[1] + x[2]   mod p
 * ```
 *
 * The team is office 0. Its whole job is: take your own number, add the two
 * masks the others sent you, subtract the two you sent them, take the
 * remainder. That is §12b arithmetic end to end -- addition, subtraction, and
 * 「割った余り」 -- and it is the actual additive-masking protocol from the
 * course, not a simplification of one.
 *
 * ## What the published partial reveals
 *
 * Nothing about `x[0]`. The published value is `x[0] + m[1][0] + m[2][0] -
 * m[0][1] - m[0][2]`, and each mask is a uniform field element the public does
 * not hold. For any candidate `x'` there is a consistent set of masks, so the
 * partial is consistent with every possible input -- information-theoretic, and
 * `mpc.test.ts` executes that claim rather than asserting it.
 *
 * This is the point of the exercise, and it is why the partial is safe to put
 * on the Public Ledger while the input never is. #645's Public Ledger rule --
 * private MPC state stays private -- is satisfied structurally: the masks and
 * `x[0]` are derived at projection time for the owning team only, and the state
 * stores neither.
 *
 * ## Why the participant cannot fake an answer
 *
 * The judge recomputes `partial[0]` from the same derivation and compares. A
 * participant who does not perform the arithmetic has to guess one value out of
 * ~2^61. They cannot read it off the ledger either: their own partial is what
 * they are being asked to produce, and the other offices are simulated by the
 * judge, so no other partial for this Order exists anywhere a participant can
 * see.
 *
 * ## Scope
 *
 * Summation only -- no multiplication, so no Beaver triples. #645 lists Beaver
 * as a candidate; addition is the vertical slice that carries the idea
 * (compute on data nobody may see) with arithmetic a first-time participant can
 * follow. Multiplication is a natural later Order and needs no change to the
 * Order model, only a new task payload.
 */

import { add, mod, sub } from "./field.ts";
import { deriveBigInt } from "./prng.ts";

/** How many offices take part in one MPC Order, including the team itself. */
export const MPC_PARTY_COUNT = 3;

/** The team's index among the offices. Office 0 is always the participant. */
export const MPC_TEAM_PARTY_INDEX = 0;

/**
 * What one team privately holds for one MPC Order.
 *
 * Derived, never stored: `projectForTeam` builds this for the Order's OWNER
 * only (`myContracts` is already filtered by team), so there is no path by
 * which another team's projection or the Public Ledger could carry it.
 */
export interface MpcPrivateInputs {
  /** This office's own confidential number. */
  readonly myInput: bigint;
  /** The masks the other offices sent to this one, in office order. */
  readonly incomingMasks: readonly bigint[];
  /** The masks this office sent to the others, in office order. */
  readonly outgoingMasks: readonly bigint[];
}

/** Office `index`'s confidential input. Trusted-side derivation. */
function derivePartyInput(seed: string, orderId: string, index: number, p: bigint): bigint {
  return deriveBigInt(seed, `mpc-input:${orderId}`, index, p);
}

/**
 * The mask office `from` sends to office `to`.
 *
 * Keyed by the ordered pair so `m[i][j]` and `m[j][i]` are independent values;
 * if they were the same number the two would cancel within a single partial
 * instead of across two, and the protocol would stop hiding anything.
 */
function deriveMask(seed: string, orderId: string, from: number, to: number, p: bigint): bigint {
  return deriveBigInt(seed, `mpc-mask:${orderId}:${from}->${to}`, 0, p);
}

/** Every office index except `self`, in ascending order. */
function otherParties(self: number): readonly number[] {
  return Array.from({ length: MPC_PARTY_COUNT }, (_unused, i) => i).filter((i) => i !== self);
}

/**
 * What the team privately holds for this Order: its own number and the four
 * masks it needs. Trusted-side derivation, handed only to the Order's owner.
 */
export function deriveMpcPrivateInputs(
  seed: string,
  orderId: string,
  p: bigint,
): MpcPrivateInputs {
  const others = otherParties(MPC_TEAM_PARTY_INDEX);
  return {
    myInput: derivePartyInput(seed, orderId, MPC_TEAM_PARTY_INDEX, p),
    incomingMasks: others.map((from) => deriveMask(seed, orderId, from, MPC_TEAM_PARTY_INDEX, p)),
    outgoingMasks: others.map((to) => deriveMask(seed, orderId, MPC_TEAM_PARTY_INDEX, to, p)),
  };
}

/**
 * The masked partial an office publishes.
 *
 * Exported so the reference solution, the tests, and the dev harness all run
 * the same arithmetic a participant would write.
 */
export function computePartial(inputs: MpcPrivateInputs, p: bigint): bigint {
  const received = inputs.incomingMasks.reduce((acc, m) => add(acc, m, p), 0n);
  const sent = inputs.outgoingMasks.reduce((acc, m) => add(acc, m, p), 0n);
  return sub(add(inputs.myInput, received, p), sent, p);
}

/** The value a correct submission must equal. Trusted-side only. */
export function expectedMpcPartial(seed: string, orderId: string, p: bigint): bigint {
  return computePartial(deriveMpcPrivateInputs(seed, orderId, p), p);
}

/**
 * The total across all three offices -- what the client actually wanted.
 *
 * Not used for scoring (the judge checks the team's own partial), and exported
 * because `mpc.test.ts` uses it to execute the protocol's whole reason for
 * existing: the three partials sum to this, so the client learns the total
 * without any office's number ever being published.
 */
export function expectedMpcTotal(seed: string, orderId: string, p: bigint): bigint {
  return Array.from({ length: MPC_PARTY_COUNT }, (_unused, i) =>
    derivePartyInput(seed, orderId, i, p),
  ).reduce((acc, x) => add(acc, x, p), 0n);
}

/**
 * Every office's partial, in office order. Trusted-side; used by the tests to
 * show the masks really do cancel.
 */
export function allPartials(seed: string, orderId: string, p: bigint): readonly bigint[] {
  return Array.from({ length: MPC_PARTY_COUNT }, (_unused, self) => {
    const others = otherParties(self);
    return computePartial(
      {
        myInput: derivePartyInput(seed, orderId, self, p),
        incomingMasks: others.map((from) => deriveMask(seed, orderId, from, self, p)),
        outgoingMasks: others.map((to) => deriveMask(seed, orderId, self, to, p)),
      },
      p,
    );
  });
}

/** Sum of `values` in F_p, as the client would combine the partials. */
export function sumInField(values: readonly bigint[], p: bigint): bigint {
  return values.reduce((acc, v) => add(acc, v, p), mod(0n, p));
}
