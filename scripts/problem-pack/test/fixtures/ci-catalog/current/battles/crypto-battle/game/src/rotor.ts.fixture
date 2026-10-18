/** Four numeric symbols, two public wheels. A teaching model, not actual Enigma. */
export const ROTOR_P = [1, 3, 0, 2] as const;
export const ROTOR_Q = [3, 0, 2, 1] as const;
export interface RotorPositions {
  readonly a: number;
  readonly b: number;
}
export interface RotorTask {
  readonly kind: "rotor-encrypt";
  /** Generation fixed when this Order was issued, retained after ROTATE. */
  readonly generation: number;
  readonly plaintext: readonly number[];
}
export interface RotorTaskProjection extends RotorTask {
  readonly myInitial: RotorPositions;
}
export const rotorValue = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 4;
export const rotorRow = (v: unknown): v is readonly number[] =>
  Array.isArray(v) && v.length === 4 && v.every(rotorValue);
export function rotorPositions(v: unknown): v is RotorPositions {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return rotorValue(p.a) && rotorValue(p.b);
}
const remainder = (v: number) => ((v % 4) + 4) % 4;
/** P and Q are public permutations. Position shifts both the input and output. */
export function rotorWheel(
  value: number,
  position: number,
  wheel: typeof ROTOR_P | typeof ROTOR_Q,
): number {
  if (!rotorValue(value) || !rotorValue(position))
    throw new Error("Rotor values and positions must be integers 0..3");
  return remainder(wheel[remainder(value + position)]! - position);
}
export function rotorStep({ a, b }: RotorPositions): RotorPositions {
  if (!rotorValue(a) || !rotorValue(b))
    throw new Error("Invalid Rotor positions");
  return { a: (a + 1) % 4, b: (b + (a === 3 ? 1 : 0)) % 4 };
}
/** Every message starts from initial; output precedes stepping. No mutable wheel state. */
export function rotorEncrypt(
  plaintext: readonly number[],
  initial: RotorPositions,
): readonly number[] {
  if (!rotorRow(plaintext) || !rotorPositions(initial))
    throw new Error("Invalid Rotor message or initial positions");
  let state = initial;
  return plaintext.map((value) => {
    const output = rotorWheel(
      rotorWheel(value, state.a, ROTOR_P),
      state.b,
      ROTOR_Q,
    );
    state = rotorStep(state);
    return output;
  });
}
/** Strict wire syntax. Empty, extra, fractional or out-of-range inputs are not attempts. */
export function parseRotorAnswer(
  value: unknown,
): readonly number[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((v) => typeof v === "string" && /^[0-3]$/.test(v))
  )
    return undefined;
  return value.map(Number);
}
