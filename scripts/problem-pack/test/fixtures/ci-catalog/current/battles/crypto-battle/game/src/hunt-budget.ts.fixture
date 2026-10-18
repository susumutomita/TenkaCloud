import { rosterOf } from "./hunt-key.ts";
import { packUnsignedSlots, unpackUnsignedSlots } from "./integer-slots.ts";
import type { CryptoBattleState, StoredHuntAttempts } from "./types.ts";

type State = Pick<CryptoBattleState, "teams" | "huntAttempts">;
type Row = readonly [width: number, counts: string];
const decoded = new WeakMap<Row, readonly number[]>();

function identity(state: Pick<State, "teams">, key: string) {
  const parts: unknown = JSON.parse(key);
  if (!Array.isArray(parts)) throw new Error("Invalid HUNT budget key");
  const sudoku = parts[0] === "sudoku",
    offset = sudoku ? 1 : 0;
  if (
    parts.length !== offset + 3 ||
    parts.slice(offset).some((n) => !Number.isSafeInteger(n))
  )
    throw new Error("Invalid HUNT budget identity");
  const [attacker, target, generation] = parts.slice(offset) as number[];
  const width = rosterOf(state.teams).ids.length;
  if (
    attacker! < 0 ||
    attacker! >= width ||
    target! < 0 ||
    target! >= width ||
    generation! < 1
  )
    throw new Error("Invalid HUNT budget roster or generation");
  if (
    JSON.stringify([
      ...(sudoku ? ["sudoku"] : []),
      attacker,
      target,
      generation,
    ]) !== key
  )
    throw new Error("Noncanonical HUNT budget key");
  return {
    row: `b:${target}:${generation}`,
    position: attacker! * 2 + (sudoku ? 1 : 0),
    width,
  };
}
function values(row: Row, width: number): readonly number[] {
  if (!Array.isArray(row) || row.length !== 2 || typeof row[1] !== "string")
    throw new Error("Invalid packed HUNT budget row");
  let result = decoded.get(row);
  if (!result) {
    result = unpackUnsignedSlots(row[1], row[0]);
    decoded.set(row, result);
  }
  if (result.length !== width * 2)
    throw new Error("HUNT budget roster length changed");
  return result;
}

/** Numeric legacy maps and schema11 rows read the same count. No projection changes. */
export function huntCount(state: State, key: string): number | undefined {
  const id = identity(state, key),
    legacy = state.huntAttempts[key];
  if (legacy !== undefined) {
    if (
      typeof legacy !== "number" ||
      !Number.isSafeInteger(legacy) ||
      legacy < 0
    )
      throw new Error("Invalid legacy HUNT count");
    if (state.huntAttempts[id.row] !== undefined)
      throw new Error("Duplicate legacy and packed HUNT counters");
    return legacy;
  }
  const row = state.huntAttempts[id.row];
  if (row === undefined) return undefined;
  if (typeof row === "number") throw new Error("Invalid packed HUNT budget");
  return values(row, id.width)[id.position] || undefined;
}

/** Lossless expansion for migration, pruning and audit tests, never participant data. */
export function expandHuntAttempts(
  state: State,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {},
    width = rosterOf(state.teams).ids.length;
  for (const [key, value] of Object.entries(state.huntAttempts)) {
    if (typeof value === "number") {
      const id = identity(state, key);
      if (state.huntAttempts[id.row] !== undefined)
        throw new Error("Duplicate legacy and packed HUNT counters");
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        Object.hasOwn(result, key)
      )
        throw new Error("Invalid or duplicate HUNT count");
      result[key] = value;
      continue;
    }
    const m = /^b:(0|[1-9]\d*):([1-9]\d*)$/.exec(key);
    if (!m) throw new Error("Invalid packed HUNT key");
    const target = Number(m[1]),
      generation = Number(m[2]);
    if (
      target >= width ||
      !Number.isSafeInteger(target) ||
      !Number.isSafeInteger(generation)
    )
      throw new Error("Invalid packed HUNT identity");
    const counts = values(value, width);
    for (let position = 0; position < counts.length; position++) {
      const count = counts[position]!;
      if (count === 0) continue;
      const logical = JSON.stringify([
        ...(position % 2 ? ["sudoku"] : []),
        Math.floor(position / 2),
        target,
        generation,
      ]);
      if (
        Object.hasOwn(result, logical) ||
        Object.hasOwn(state.huntAttempts, logical)
      )
        throw new Error("Duplicate HUNT counters");
      result[logical] = count;
    }
  }
  return result;
}

export function packHuntAttempts(state: State): StoredHuntAttempts {
  const rows = new Map<string, number[]>();
  for (const [key, count] of Object.entries(expandHuntAttempts(state))) {
    const id = identity(state, key);
    if (!count) continue;
    const row = rows.get(id.row) ?? Array<number>(id.width * 2).fill(0);
    row[id.position] = count;
    rows.set(id.row, row);
  }
  return Object.fromEntries(
    [...rows].map(([key, counts]) => {
      const packed = packUnsignedSlots(counts);
      return [key, [packed.width, packed.text] as const];
    }),
  );
}

/** One immutable row update; old/custom counts keep their full safe-integer range. */
export function changeHuntCount(
  state: State,
  key: string,
  delta: 1 | -1,
): StoredHuntAttempts {
  const source = Object.values(state.huntAttempts).some(
    (v) => typeof v === "number",
  )
    ? packHuntAttempts(state)
    : state.huntAttempts;
  const id = identity(state, key),
    stored = source[id.row];
  if (typeof stored === "number") throw new Error("Invalid packed HUNT row");
  const row = stored
    ? [...values(stored, id.width)]
    : Array<number>(id.width * 2).fill(0);
  const next = row[id.position]! + delta;
  if (!Number.isSafeInteger(next) || next < 0)
    throw new Error("HUNT refund has no reservation or count overflows");
  row[id.position] = next;
  const result = { ...source };
  if (row.every((v) => v === 0)) delete result[id.row];
  else {
    const packed = packUnsignedSlots(row);
    result[id.row] = [packed.width, packed.text];
  }
  return result;
}
