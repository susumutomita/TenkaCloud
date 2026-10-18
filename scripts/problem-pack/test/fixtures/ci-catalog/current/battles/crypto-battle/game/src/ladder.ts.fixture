/**
 * #659 / #661: time-based cipher ladder, with public methods and private keys.
 * Build uses Caesar; normal pressure alternates Vigenère and Rotor.
 * Endgame rush cipher slots retain Vigenère.
 * Normal endgame cipher slots are the separate rsa-encrypt task (rsa.ts).
 * Vigenère Orders deliberately expose one public key position at a time.
 * Three different positions disclose the cycle; repeated copies of one do not.
 * A full known plaintext/ciphertext pair covering a cycle WOULD reveal all keys.
 * These classical ciphers provide no modern chosen-plaintext security.
 *
 * Browser-safe: only arithmetic, input shape and public material coverage live
 * here. Seed-derived keys and plaintexts remain server-side in fixtures.ts.
 * Rotor has a separate stateful task in rotor.ts; the existing encrypted-addition
 * Order is an addition-only teaching model, not full FHE.
 */

/** The shift-cipher rungs. RSA has its own public-key task shape in rsa.ts. */
export type CipherRung = "caesar" | "vigenere";
export type CipherKey = number | readonly number[];

export interface CipherRungSpec {
  readonly rung: CipherRung;
  /** Number of independently chosen shifts in one cycle. */
  readonly keyLength: number;
  /**
   * The alphabet, in order. Position IS the numeric value, so `symbols[2]` is
   * the symbol for 2, and the length is the modulus.
   */
  readonly symbols: readonly string[];
  /**
   * How many published (plaintext, ciphertext) pairs let an attacker recover
   * the key — #659 §2's 「鍵を割るのに必要な公開数」 column, and the number the
   * whole ladder exists to vary. One, for Caesar: a single position gives
   * `k = (c - p) mod n` outright.
   *
   * Not enforced by the reducer, and deliberately so. The judge checks whether
   * a submitted key is RIGHT, never whether the attacker had enough material to
   * deduce it — a team that guesses `k` on a 6-symbol alphabet has a one-in-six
   * chance and is welcome to it. This number is what the Order DISCLOSES, so a
   * team can weigh "how much does leaking this cost me" before leaking.
   */
  readonly pairsToBreak: number;
  /**
   * How long a plaintext this rung asks for.
   *
   * #659 §4 sizes every Order at roughly five minutes of hand calculation,
   * because the deadline IS the compute budget. This length is an ESTIMATE of
   * that for one modular addition per symbol, not a measured figure — #659 §15
   * names a paper playtest as the next step precisely because no simulation
   * settles how long a person actually takes.
   */
  readonly plaintextLength: number;
  /** Attacker reward: Caesar's #661 exception is 8; Vigenère uses #659's 25. */
  readonly huntBonus: number;
}

/**
 * Dice faces: six symbols, no words, legible at any size, and a modulus large
 * enough that a middle-school player has to write the arithmetic down without
 * being large enough to want a calculator (#659 §3: 「mod 3 は暗算、mod 9 は手を
 * 動かす」 — six sits between them).
 *
 * Also chosen because they RENDER. #659 §3 leads with じゃんけん (✊ ✌️ 🖐), and
 * measuring glyph widths in a browser during verification showed those three
 * resolving to tofu while ⚀-⚅ resolved to real glyphs — a symbol set that shows
 * as boxes fails the language-neutrality argument in the worst possible way,
 * because the participant cannot read the Order at all. Emoji live outside the
 * BMP or carry a U+FE0F presentation selector and depend on an emoji font being
 * installed; these are plain BMP symbol characters and ride the text font.
 * `ladder.test.ts` pins that property for every rung that comes later.
 */
const DICE: readonly string[] = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

export const CIPHER_RUNGS: Readonly<Record<CipherRung, CipherRungSpec>> = {
  caesar: {
    rung: "caesar",
    keyLength: 1,
    symbols: DICE,
    pairsToBreak: 1,
    plaintextLength: 3,
    huntBonus: 8,
  },
  vigenere: {
    rung: "vigenere",
    keyLength: 3,
    symbols: DICE,
    // Each issued Order is one position of the public three-position cycle.
    // Three DISTINCT positions, not three arbitrary records, reveal the key.
    pairsToBreak: 3,
    plaintextLength: 1,
    huntBonus: 25,
  },
};

/** Every rung, in ladder order (weakest first). */
export const ALL_CIPHER_RUNGS: readonly CipherRung[] = ["caesar", "vigenere"];

export function rungSpec(rung: CipherRung): CipherRungSpec {
  return CIPHER_RUNGS[rung];
}

/**
 * Apply the rung's cipher. For Caesar: shift every symbol forward by the key
 * and take the remainder — exactly the arithmetic a participant does by hand,
 * written once so the judge and the worked example in the Order cannot drift
 * apart.
 */
export function encryptWithRung(
  plaintext: readonly number[],
  key: CipherKey,
  rung: CipherRung,
  keyPosition = 0,
): readonly number[] {
  const modulus = rungSpec(rung).symbols.length;
  if (!validCipherKey(key, rung)) throw new Error("encryptWithRung: invalid key");
  switch (rung) {
    case "caesar":
      return plaintext.map((value) => (value + cipherKeyAt(key, 0)) % modulus);
    case "vigenere":
      return plaintext.map((value, i) => (value + cipherKeyAt(key, keyPosition + i)) % modulus);
    default: {
      const exhaustive: never = rung;
      throw new Error(`encryptWithRung: unhandled rung ${String(exhaustive)}`);
    }
  }
}

/** Render symbol values as the pictures a participant actually sees. */
export function toSymbols(values: readonly number[], rung: CipherRung): readonly string[] {
  const { symbols } = rungSpec(rung);
  return values.map((value) => symbols[value] ?? "?");
}

/**
 * Parse a participant-submitted answer.
 *
 * Accepts either the pictures or their numeric values, because a browser that
 * cannot type ⚀ should not be a scoring disadvantage. Returns `undefined` for
 * anything else rather than throwing: a malformed answer is a rejected op, not
 * a crashed match — the same contract every other participant-supplied value in
 * this game is held to.
 */
export function parseAnswer(
  raw: readonly string[],
  rung: CipherRung,
): readonly number[] | undefined {
  const { symbols } = rungSpec(rung);
  if (!Array.isArray(raw) || raw.some(token => typeof token !== "string")) return undefined;
  const values: number[] = [];
  for (const token of raw) {
    const trimmed = token.trim();
    const bySymbol = symbols.indexOf(trimmed);
    if (bySymbol >= 0) {
      values.push(bySymbol);
      continue;
    }
    if (!/^\d+$/.test(trimmed)) return undefined;
    const numeric = Number(trimmed);
    if (numeric >= symbols.length) return undefined;
    values.push(numeric);
  }
  return values;
}

/** These helpers only check public input shape, never recover an answer. */
export function isCipherRung(value: unknown): value is CipherRung {
  return typeof value === "string" && Object.hasOwn(CIPHER_RUNGS, value);
}
export function validCipherKey(value: unknown, rung: CipherRung): value is CipherKey {
  const spec = rungSpec(rung);
  const part = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < spec.symbols.length;
  return rung === "caesar" ? part(value)
    : Array.isArray(value) && value.length === spec.keyLength && value.every(part);
}
export function cipherKeyAt(key: CipherKey, position: number): number {
  if (typeof key === "number") return key;
  const value = key[position % key.length];
  if (value === undefined) throw new Error("cipherKeyAt: missing key position");
  return value;
}
/** Only public material coverage. Repeated records at one position add no coverage. */
export function exposedKeyPositions(
  pairs: readonly { readonly plaintext: readonly number[]; readonly keyPosition?: number }[],
  rung: CipherRung,
): readonly number[] {
  const length = rungSpec(rung).keyLength;
  return [...new Set(pairs.flatMap(pair => pair.plaintext.map((_, i) => ((pair.keyPosition ?? 0) + i) % length)))].sort();
}
