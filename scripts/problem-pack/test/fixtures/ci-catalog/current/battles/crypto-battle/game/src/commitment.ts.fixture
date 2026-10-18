/**
 * [Issue #710] ZK rock-paper-scissors -- a commitment you can compute on paper.
 *
 * The Order is the course's commit -> reveal (w4-commit-open) played as
 * じゃんけん between two teams. Each team picks a hand `m` and a blinding `r`,
 * publishes `c = g^m * h^r mod p`, and only once BOTH commitments are on the
 * board opens `(m, r)`. The judge (this Battle's trusted reducer) recomputes
 * `g^m * h^r` and compares it with `c`; the hands then decide the round. This
 * module is that arithmetic and nothing else: no state, no randomness, no I/O
 * -- the reducer decides who plays whom and when a deadline expires.
 *
 * ## The group
 *
 * p = 23 is a safe prime (q = 11), and g = 4 = 2^2, h = 9 = 3^2 are both
 * visibly squares, so both sit in the order-11 subgroup of quadratic residues.
 * That subgroup is where a Pedersen commitment has to live: with a prime order
 * the exponents are the field Z_11, `r` ranges over all of it, and `h^r` blinds
 * uniformly. Issue #710's draft picked g = 5, h = 7; those are non-residues of
 * order 22 (the test computes it), which would put the exercise in the wrong
 * object. The same "square it" argument picks g = 4 for the 2048-bit group in
 * `group.ts`; the arithmetic here is that arithmetic at a size that fits on a
 * napkin.
 *
 * **This group has no security -- it is a teaching size**, exactly as
 * `sudoku.ts` says of its 4x4 board. Every quadratic residue is a power of 4
 * (there are only 11 of them), so `log_g h` exists and anyone finds it in
 * eleven multiplications: it is 8, and `commitment.test.ts` measures it rather
 * than trusting this sentence. A real Pedersen commitment picks h by hashing
 * so that nobody knows that logarithm; here everybody does. What the 33
 * possible openings (3 hands x 11 blindings) are for is that ONE commitment is
 * three to seven two-digit multiplications, and that a person who has done it
 * once has done the real thing. The participant-facing copy must say so.
 *
 * ## Blinding ranges over Z_11, not 1..10
 *
 * `r` is 0..10 -- the whole exponent field, eleven values -- because that is
 * the only range under which the commitment hides. With `r` in 1..10 the blind
 * `h^r` never equals 1, so `c` can never equal a bare `g^m`; a hunter who sees
 * c = 4 = g^1 knows the hand is not グー and plays チョキ for a guaranteed
 * no-loss. That leak is enumerated in the tests (exactly three commitments,
 * each ruling out exactly one hand) and is why the range is what it is: with
 * r in Z_11 every commitment opens to every hand in exactly one way, which is
 * perfect hiding, and the tests count it.
 *
 * ## What the judge's check does and does not catch
 *
 * Binding is only computational, and at this size it is broken for anyone who
 * knows `L = log_g h`: `(m', r + (m - m') / L mod 11)` opens the same `c` to a
 * different hand (with L = 8 the division is multiplication by 7, and the test
 * computes that inverse too). The judge's recomputation catches the careless
 * swap -- a new
 * hand with the old `r` -- which is the lesson the Order teaches; it cannot
 * catch a cheater who solved the eleven-element logarithm. Both facts are
 * measured in the tests. Soundness against that cheater is not this module's
 * job (nothing at p = 23 could provide it); it is the reducer's, by scoring.
 *
 * ## The leak the hunt is built on
 *
 * Reuse `r` across two rounds and the commitments divide to
 * `c1 / c2 = g^(m1 - m2)`, which anyone reads off in five tries -- and with
 * round one's hand already opened, that is round two's hand.
 * {@link handDifferenceFromReusedRandomness} is the detector, this Battle's
 * `hunt-commit` counterpart of `sudoku.ts`'s `assembleReusedRelabeling`.
 */

/** p = 23 = 2q + 1, q = 11; g = 4 = 2^2 and h = 9 = 3^2 generate the order-q subgroup. */
export const RPS_GROUP: { readonly p: number; readonly q: number; readonly g: number; readonly h: number } = {
  p: 23,
  q: 11,
  g: 4,
  h: 9,
};

/** 1 = グー, 2 = チョキ, 3 = パー. */
export type Hand = 1 | 2 | 3;

export const HANDS: readonly Hand[] = [1, 2, 3];

export const HAND_NAMES: Readonly<Record<Hand, string>> = { 1: "グー", 2: "チョキ", 3: "パー" };

/** The blinding values: all of Z_q -- see the module header for why 0 is included. */
export const RPS_RANDOMNESS: readonly number[] = Array.from({ length: RPS_GROUP.q }, (_, i) => i);

export function isHand(m: number): m is Hand {
  return m === 1 || m === 2 || m === 3;
}

export function isRandomness(r: number): boolean {
  return Number.isInteger(r) && r >= 0 && r < RPS_GROUP.q;
}

function mod(a: number, p: number): number {
  return ((a % p) + p) % p;
}

/**
 * `base^exp mod p` by plain repeated multiplication. Exponents here are at most
 * 10, and this is deliberately NOT the square-and-multiply ladder that
 * {@link handWork} narrates, so the test that the two agree checks something.
 */
function powMod(base: number, exp: number, p: number): number {
  if (!Number.isInteger(exp) || exp < 0) {
    throw new RangeError(`commitment.powMod: exponent ${exp} must be a non-negative integer`);
  }
  let result = 1;
  for (let i = 0; i < exp; i += 1) result = mod(result * base, p);
  return result;
}

/** `c = g^m * h^r mod p`. Throws on a hand or blinding outside the Order's ranges. */
export function commit(m: Hand, r: number): number {
  if (!isHand(m)) throw new RangeError(`commitment.commit: hand ${m} is not 1, 2 or 3`);
  if (!isRandomness(r)) throw new RangeError(`commitment.commit: blinding ${r} is not in 0..${RPS_GROUP.q - 1}`);
  const { p, g, h } = RPS_GROUP;
  return mod(powMod(g, m, p) * powMod(h, r, p), p);
}

/**
 * The judge's check at reveal: does `(m, r)` open `c`? A hand or blinding outside
 * the Order's ranges is an opening that fails, not a programming error.
 */
export function verifyOpening(c: number, m: number, r: number): boolean {
  if (!isHand(m) || !isRandomness(r)) return false;
  return commit(m, r) === c;
}

export type RpsOutcome = "first" | "second" | "draw";

/** グー beats チョキ, チョキ beats パー, パー beats グー: the first hand wins when `m1 - m2 ≡ 2 (mod 3)`. */
export function rpsOutcome(m1: Hand, m2: Hand): RpsOutcome {
  const d = mod(m1 - m2, 3);
  if (d === 0) return "draw";
  return d === 2 ? "first" : "second";
}

/**
 * Brute-force discrete logarithm in the order-q subgroup: the `e` in 0..q-1 with
 * `base^e ≡ target`, or undefined when `target` is not a power of `base`. Eleven
 * multiplications -- the reason this group has no security, and the tool the
 * tests use to measure that rather than assert it.
 */
export function discreteLog(target: number, base: number = RPS_GROUP.g): number | undefined {
  const { p, q } = RPS_GROUP;
  const want = mod(target, p);
  let acc = 1;
  for (let e = 0; e < q; e += 1) {
    if (acc === want) return e;
    acc = mod(acc * base, p);
  }
  return undefined;
}

/**
 * The hunt: if `c1` and `c2` were made with the SAME blinding, then
 * `c1 * c2^-1 = g^(m1 - m2)`, and the difference is one of -2..2. Returns that
 * difference, or undefined when the ratio is not `g^d` for any such `d`.
 *
 * When the blindings differ the ratio is `g^(m1 - m2) * h^(r1 - r2)`, which is
 * never `g^(m1 - m2)` (the tests enumerate this): the detector then returns a
 * wrong difference or nothing, never the true one -- a hunter who guesses on a
 * fresh `r` is guessing, and the reducer prices that.
 */
export function handDifferenceFromReusedRandomness(c1: number, c2: number): number | undefined {
  const { p, g } = RPS_GROUP;
  const ratio = mod(c1 * powMod(mod(c2, p), p - 2, p), p);
  for (let d = -2; d <= 2; d += 1) {
    if (powMod(g, mod(d, RPS_GROUP.q), p) === ratio) return d;
  }
  return undefined;
}

/**
 * One line of the paper walkthrough. `term` names what the line computes
 * ("4^3", "9^10", "c"); a line with `factors` is one multiplication, written
 * symbolically in `using` and numerically in `factors`; `product` is before
 * reduction and `value` after -- the number carried to the next line.
 */
export interface HandWorkStep {
  readonly term: string;
  readonly using?: readonly [string, string];
  readonly factors?: readonly [number, number];
  readonly product: number;
  readonly value: number;
}

function multiplyStep(term: string, using: readonly [string, string], factors: readonly [number, number]): HandWorkStep {
  const product = factors[0] * factors[1];
  return { term, using, factors, product, value: mod(product, RPS_GROUP.p) };
}

/**
 * `base^exp` the way the course taught it: square up to the largest power of two
 * that fits, then multiply the pieces of `exp`'s binary expansion together --
 * at most four multiplications for any `exp` up to 10, against nine for
 * multiplying by the base again and again. Exponents 0 and 1 are a line with
 * no multiplication, so the walkthrough still shows where the number came from.
 */
function powerSteps(base: number, exp: number): HandWorkStep[] {
  const name = (e: number): string => (e === 1 ? `${base}` : `${base}^${e}`);
  if (exp === 0) return [{ term: `${base}^0`, product: 1, value: 1 }];
  if (exp === 1) return [{ term: `${base}^1`, product: base, value: base }];
  const steps: HandWorkStep[] = [];
  const known = new Map<number, number>([[1, base]]);
  const square = (e: number): void => {
    const half = known.get(e / 2) ?? 0;
    const step = multiplyStep(name(e), [name(e / 2), name(e / 2)], [half, half]);
    known.set(e, step.value);
    steps.push(step);
  };
  for (let e = 2; e <= exp; e *= 2) square(e);
  let accExp = 0;
  for (let bit = 8; bit >= 1; bit /= 2) {
    if ((exp & bit) === 0) continue;
    if (accExp === 0) {
      accExp = bit;
      continue;
    }
    const step = multiplyStep(
      name(accExp + bit),
      [name(accExp), name(bit)],
      [known.get(accExp) ?? 0, known.get(bit) ?? 0],
    );
    accExp += bit;
    known.set(accExp, step.value);
    steps.push(step);
  }
  return steps;
}

/** The structured walkthrough behind {@link handWorkSteps}; its last line's `value` is `commit(m, r)`. */
export function handWork(m: Hand, r: number): HandWorkStep[] {
  if (!isHand(m)) throw new RangeError(`commitment.handWork: hand ${m} is not 1, 2 or 3`);
  if (!isRandomness(r)) throw new RangeError(`commitment.handWork: blinding ${r} is not in 0..${RPS_GROUP.q - 1}`);
  const { g, h } = RPS_GROUP;
  const gSteps = powerSteps(g, m);
  const hSteps = powerSteps(h, r);
  const gLast = gSteps[gSteps.length - 1];
  const hLast = hSteps[hSteps.length - 1];
  if (!gLast || !hLast) throw new Error("commitment.handWork: a power walkthrough was empty");
  return [...gSteps, ...hSteps, multiplyStep("c", [gLast.term, hLast.term], [gLast.value, hLast.value])];
}

function renderStep(step: HandWorkStep): string {
  const { p } = RPS_GROUP;
  if (!step.factors || !step.using) return `${step.term} = ${step.value}`;
  const symbolic = step.using.join(" × ");
  const numeric = step.factors.join(" × ");
  const lead = symbolic === numeric ? `${step.term} = ${numeric}` : `${step.term} = ${symbolic} = ${numeric}`;
  return step.product < p ? `${lead} = ${step.product}` : `${lead} = ${step.product} → mod ${p} = ${step.value}`;
}

/**
 * The lines a person writes on paper to reach `commit(m, r)`, with the player's
 * own numbers, so a hint can print the walkthrough. E.g. for (2, 10):
 *
 *     4^2 = 4 × 4 = 16
 *     9^2 = 9 × 9 = 81 → mod 23 = 12
 *     9^4 = 9^2 × 9^2 = 12 × 12 = 144 → mod 23 = 6
 *     9^8 = 9^4 × 9^4 = 6 × 6 = 36 → mod 23 = 13
 *     9^10 = 9^8 × 9^2 = 13 × 12 = 156 → mod 23 = 18
 *     c = 4^2 × 9^10 = 16 × 18 = 288 → mod 23 = 12
 */
export function handWorkSteps(m: Hand, r: number): string[] {
  return handWork(m, r).map(renderStep);
}

/** Accept only the nonzero order-11 subgroup, including 1. */
export function isCommitment(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value < RPS_GROUP.p && powMod(value, RPS_GROUP.q, RPS_GROUP.p) === 1;
}
