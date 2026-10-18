/** Untimed once-only guards. A bit records success, never an invented audit time. */
import { huntKey, rosterOf, rsaHuntKey } from "./hunt-key.ts";
import { packUnsignedSlots, unpackUnsignedSlots } from "./integer-slots.ts";
import type { CryptoBattleState } from "./types.ts";
type Source = Pick<CryptoBattleState, "teams" | "successfulHunts">;
const METHODS = ["share", "sudoku", "caesar", "vigenere", "rsa"] as const;
type Method = (typeof METHODS)[number];
interface Identity {
  method: Method;
  attacker: number;
  target: number;
  generation: number;
}
function logical(state: Source, id: Identity): string {
  const ids = rosterOf(state.teams).ids,
    a = ids[id.attacker]!,
    t = ids[id.target]!;
  if (id.method === "share") return huntKey(a, t, id.generation);
  if (id.method === "rsa") return rsaHuntKey(state, a, t, id.generation);
  return JSON.stringify(
    id.method === "sudoku"
      ? ["sudoku", a, t, id.generation]
      : ["cipher", a, t, id.generation, id.method],
  );
}
function identity(state: Source, key: string): Identity {
  const roster = rosterOf(state.teams);
  let method: Method,
    attacker: number | undefined,
    target: number | undefined,
    generation: number;
  if (key.startsWith("r")) {
    const match = /^r([0-9a-z]+):([1-9]\d*)$/.exec(key);
    if (!match) throw new Error("Invalid RSA HUNT guard");
    const pair = Number.parseInt(match[1]!, 36);
    if (!Number.isSafeInteger(pair) || pair.toString(36) !== match[1])
      throw new Error("Invalid RSA HUNT pair");
    method = "rsa";
    attacker = Math.floor(pair / roster.ids.length);
    target = pair % roster.ids.length;
    generation = Number(match[2]);
  } else {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts)) throw new Error("Invalid HUNT guard");
    const offset = parts.length === 3 ? 0 : 1;
    method =
      offset === 0
        ? "share"
        : parts[0] === "sudoku" && parts.length === 4
          ? "sudoku"
          : parts[0] === "cipher" &&
              parts.length === 5 &&
              (parts[4] === "caesar" || parts[4] === "vigenere")
            ? parts[4]
            : undefined;
    if (
      !method ||
      parts.length !== (method === "share" ? 3 : method === "sudoku" ? 4 : 5)
    )
      throw new Error("Invalid HUNT guard method");
    attacker =
      typeof parts[offset] === "string"
        ? roster.positions.get(parts[offset])
        : undefined;
    target =
      typeof parts[offset + 1] === "string"
        ? roster.positions.get(parts[offset + 1])
        : undefined;
    generation = parts[offset + 2];
  }
  if (
    attacker === undefined ||
    target === undefined ||
    roster.ids[attacker] === undefined ||
    roster.ids[target] === undefined ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    throw new Error("Invalid HUNT guard identity");
  const result = { method, attacker, target, generation };
  if (logical(state, result) !== key)
    throw new Error("Non-canonical HUNT guard");
  return result;
}
function prefix(id: Omit<Identity, "attacker">) {
  return `g:${METHODS.indexOf(id.method)}:${id.target}:${id.generation}:`;
}
function row(state: Source, key: string) {
  const match = /^g:([0-4]):(0|[1-9]\d*):([1-9]\d*):([A-Za-z0-9_-]+)$/.exec(
    key,
  );
  if (!match) throw new Error("Invalid packed HUNT guard");
  const target = Number(match[2]),
    generation = Number(match[3]),
    count = rosterOf(state.teams).ids.length;
  const values = unpackUnsignedSlots(match[4]!, 1);
  if (
    !Number.isSafeInteger(target) ||
    target >= count ||
    !Number.isSafeInteger(generation) ||
    values.length !== Math.ceil(count / 6) ||
    (count % 6 && values.at(-1)! >= 2 ** (count % 6))
  )
    throw new Error("Invalid packed HUNT guard identity");
  return { method: METHODS[Number(match[1])]!, target, generation, values };
}
type GuardIndex = {
  readonly rows: ReadonlyMap<string, number>;
  readonly legacy: ReadonlySet<string>;
};
const guardIndexes = new WeakMap<readonly string[], GuardIndex>();
function indexGuards(guards: readonly string[]): GuardIndex {
  const cached = guardIndexes.get(guards);
  if (cached) return cached;
  const rows = new Map<string, number>(),
    legacy = new Set<string>();
  for (const [i, key] of guards.entries()) {
    if (key.startsWith("g:")) {
      const prefix = key.slice(0, key.lastIndexOf(":") + 1);
      if (rows.has(prefix)) throw new Error("Duplicate HUNT guards");
      rows.set(prefix, i);
    } else legacy.add(key);
  }
  const result = { rows, legacy };
  guardIndexes.set(guards, result);
  return result;
}
export function hasSuccessfulHunt(state: Source, key: string): boolean {
  const id = identity(state, key),
    index = indexGuards(state.successfulHunts);
  if (index.legacy.has(key)) return true;
  const at = index.rows.get(prefix(id));
  if (at === undefined) return false;
  const r = row(state, state.successfulHunts[at]!);
  return (
    (r.values[Math.floor(id.attacker / 6)]! & (1 << (id.attacker % 6))) !== 0
  );
}
export function recordSuccessfulHunt(
  state: Source,
  key: string,
): readonly string[] {
  const id = identity(state, key),
    wanted = prefix(id);
  if (hasSuccessfulHunt(state, key)) return state.successfulHunts;
  const previous = indexGuards(state.successfulHunts),
    index = previous.rows.get(wanted) ?? -1;
  const values =
    index < 0
      ? Array(Math.ceil(rosterOf(state.teams).ids.length / 6)).fill(0)
      : row(state, state.successfulHunts[index]!).values;
  values[Math.floor(id.attacker / 6)]! |= 1 << (id.attacker % 6);
  const packed = wanted + packUnsignedSlots(values).text;
  const result =
    index < 0
      ? [...state.successfulHunts, packed]
      : state.successfulHunts.map((entry, i) => (i === index ? packed : entry));
  guardIndexes.set(
    result,
    index < 0
      ? {
          rows: new Map([
            ...previous.rows,
            [wanted, state.successfulHunts.length],
          ]),
          legacy: previous.legacy,
        }
      : previous,
  );
  return result;
}
export function expandSuccessfulHunts(state: Source): string[] {
  const result: string[] = [];
  for (const entry of state.successfulHunts) {
    if (!entry.startsWith("g:")) {
      identity(state, entry);
      result.push(entry);
      continue;
    }
    const r = row(state, entry);
    for (
      let attacker = 0;
      attacker < rosterOf(state.teams).ids.length;
      attacker++
    )
      if ((r.values[Math.floor(attacker / 6)]! & (1 << (attacker % 6))) !== 0)
        result.push(logical(state, { ...r, attacker }));
  }
  if (new Set(result).size !== result.length)
    throw new Error("Duplicate HUNT guards");
  return result;
}
export function compactSuccessfulHunts(state: Source): readonly string[] {
  let successfulHunts: readonly string[] = [];
  for (const key of expandSuccessfulHunts(state))
    successfulHunts = recordSuccessfulHunt({ ...state, successfulHunts }, key);
  return successfulHunts;
}
/** RSA guard-only legacy rows retain the existing retired-generation policy. */
export function retainCurrentRsaGuards(state: Source): readonly string[] {
  return state.successfulHunts.filter((key) => {
    if (!key.startsWith("r") && !key.startsWith("g:4:")) return true;
    const id = key.startsWith("g:") ? row(state, key) : identity(state, key);
    return (
      id.method !== "rsa" ||
      state.teams[rosterOf(state.teams).ids[id.target]!]!.generation ===
        id.generation
    );
  });
}
