import {
  compactSuccessfulHunts,
  expandSuccessfulHunts,
} from "./hunt-success.ts";
import { rsaHuntKey } from "./hunt-key.ts";
/** Lossless Shamir, Sudoku, RSA and Rotor audit rows; no success or timestamp is discarded on ROTATE.
 *
 * A fixed, sorted match roster supplies identities. Each target/generation has
 * one tuple; one slot per other team stores (atMs - baseAtMs + 1), with zero
 * meaning absent. Slots use absolute offsets or smaller signed differences between present slots.
 * Timestamps remain exact even when attacks arrive at different milliseconds.
 * Legacy objects remain readable. Migration compacts them only when the exact
 * replay order survives; otherwise the entire old huntLog is retained. Untimed
 * reservations never fabricate a success time here.
 */
import { predictionKey, predictionTeam, huntKey } from "./hunt-key.ts";
import type {
  CryptoBattleState,
  HuntLogEntry,
  StoredHuntLogEntry,
} from "./types.ts";

import {
  packHuntTimeSlots as pack,
  unpackHuntTimeSlots as unpack,
} from "./hunt-time-slots.ts";
import { packUnsignedSlots, unpackUnsignedSlots } from "./integer-slots.ts";

type DenseBlock = Exclude<StoredHuntLogEntry, HuntLogEntry>;
type DenseKind = "rsa" | "rotor" | "share" | "sudoku";
const kindOf = (block: DenseBlock): DenseKind =>
  "rsa" in block
    ? "rsa"
    : "rotor" in block
      ? "rotor"
      : "share" in block
        ? "share"
        : "sudoku";
const valuesOf = (block: DenseBlock) =>
  "rsa" in block
    ? block.rsa
    : "rotor" in block
      ? block.rotor
      : "share" in block
        ? block.share
        : block.sudoku;

/** Immutable log arrays share slot positions when only a row's values change.
 * Projection asks about every opponent/method; rescanning the complete history
 * for each lookup would multiply a 99-team ledger read by the whole roster. */
type LogIndex = {
  readonly dense: ReadonlyMap<string, number>;
  readonly legacy: ReadonlySet<string>;
  readonly latestTime: number;
  readonly nextOrder: number;
};
const logIndexes = new WeakMap<readonly StoredHuntLogEntry[], LogIndex>();
const denseKey = (kind: DenseKind, target: number, generation: number) =>
  `${kind}:${target}:${generation}`;
const legacyKey = (
  kind: DenseKind,
  attacker: string,
  target: string,
  generation: number,
) => JSON.stringify([kind, attacker, target, generation]);
function indexLog(log: readonly StoredHuntLogEntry[]): LogIndex {
  const cached = logIndexes.get(log);
  if (cached) return cached;
  const dense = new Map<string, number>(),
    legacy = new Set<string>();
  for (const [at, entry] of log.entries()) {
    if ("attackerTeamId" in entry)
      legacy.add(
        legacyKey(
          entry.via ?? "share",
          entry.attackerTeamId,
          entry.targetTeamId,
          entry.generation,
        ),
      );
    else {
      const [target, generation] = valuesOf(entry);
      const key = denseKey(kindOf(entry), target, generation);
      if (dense.has(key)) throw new Error("Duplicate dense HUNT row");
      dense.set(key, at);
    }
  }
  const timing = lastOrder(log);
  const index = { dense, legacy, ...timing };
  logIndexes.set(log, index);
  return index;
}

/** Ranks exist only when needed to retain order within one exact millisecond.
 * Normal monotonic appends use the cached latest time; unusual old-time appends
 * and reloads inspect stored rows. Ranks are not timestamps or public artifacts.
 */
function lastOrder(log: readonly StoredHuntLogEntry[], requested?: number) {
  let latestTime = requested ?? -Infinity, count = 0, maxOrder = 0;
  const visit = (time: number, rank: number) => {
    if (requested !== undefined && time !== requested) return;
    if (time > latestTime) { latestTime = time; count = 0; maxOrder = 0; }
    if (time === latestTime) { count++; maxOrder = Math.max(maxOrder, rank + 1); }
  };
  for (const entry of log) {
    if ("attackerTeamId" in entry) visit(entry.atMs, 0);
    else {
      const [, , base, width, text, orderWidth, orderText] = valuesOf(entry);
      const times = unpack(text, width);
      const ranks = readOrders(orderWidth, orderText, times);
      times.forEach((offset, i) => { if (offset) visit(base + offset - 1, ranks[i]!); });
    }
  }
  return { latestTime, nextOrder: Math.max(count, maxOrder) };
}
function readOrders(width: number | undefined, text: string | undefined, times: readonly number[]) {
  if (width === undefined && text === undefined) return times.map(() => 0);
  if (width === undefined || text === undefined) throw new Error("Incomplete HUNT order slots");
  let ranks: number[];
  if (width === 11) {
    const parts = text.split(':');
    if (parts.length !== 3 || !/^[1-9]$/.test(parts[0]!)) throw new Error("Invalid HUNT rank dictionary");
    const dictionary = unpackUnsignedSlots(parts[1]!, Number(parts[0]));
    if (dictionary.length < 2 || dictionary.length > times.length || new Set(dictionary).size !== dictionary.length)
      throw new Error("Invalid HUNT rank dictionary");
    const bits = Math.ceil(Math.log2(dictionary.length));
    if (parts[2]!.length !== Math.ceil(times.length * bits / 6)) throw new Error("Invalid HUNT rank indices");
    ranks = [];
    let buffer = 0, remaining = 0;
    for (const digit of unpackUnsignedSlots(parts[2]!, 1)) {
      buffer = buffer * 64 + digit; remaining += 6;
      while (remaining >= bits && ranks.length < times.length) {
        remaining -= bits;
        const index = Math.floor(buffer / 2 ** remaining);
        buffer %= 2 ** remaining;
        if (index >= dictionary.length) throw new Error("Invalid HUNT rank index");
        ranks.push(dictionary[index]!);
      }
    }
    if (ranks.length !== times.length || buffer !== 0) throw new Error("Invalid HUNT rank padding");
  } else if (width === 10) {
    const separator = text.indexOf(':');
    const motifWidth = Number(text.slice(0, separator));
    if (separator < 1 || !/^(?:-?[1-9]|12)$/.test(text.slice(0, separator)))
      throw new Error("Invalid HUNT order motif");
    const motif = unpack(text.slice(separator + 1), motifWidth);
    if (!motif.length || motif.length > times.length) throw new Error("Invalid HUNT order motif");
    ranks = times.map((_, i) => motif[i % motif.length]!);
  } else if (width === 0) {
    if (!/^-?\d+,-?\d+$/.test(text)) throw new Error("Invalid HUNT order progression");
    const [start, step] = text.split(",").map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(step)) throw new Error("Invalid HUNT order progression");
    ranks = times.map((time, i) => time ? start! + step! * i : 0);
    if (ranks.some(rank => !Number.isSafeInteger(rank) || rank < 0)) throw new Error("Invalid HUNT order progression");
  } else ranks = unpack(text, width);
  if (ranks.length !== times.length || ranks.some((rank, i) => rank !== 0 && times[i] === 0))
    throw new Error("Invalid HUNT order slots");
  return ranks;
}

function packOrders(ranks: readonly number[], times: readonly number[]) {
  let packed = pack(ranks);
  // A repeated sequence retains every rank, including a final partial repeat.
  // Find its shortest period in linear time for every append.
  const prefix = ranks.map(() => 0);
  for (let i = 1; i < ranks.length; i++) {
    let length = prefix[i - 1]!;
    while (length > 0 && ranks[i] !== ranks[length]) length = prefix[length - 1]!;
    if (ranks[i] === ranks[length]) length++;
    prefix[i] = length;
  }
  const period = ranks.length - (prefix.at(-1) ?? 0);
  if (period < ranks.length) {
    const motif = pack(ranks.slice(0, period));
    const text = `${motif.width}:${motif.text}`;
    if (text.length + 1 < packed.text.length) packed = { width: 10, text };
  }
  const dictionary = [...new Set(ranks)].sort((a, b) => a - b);
  if (dictionary.length > 1) {
    const bits = Math.ceil(Math.log2(dictionary.length));
    const indexOf = new Map(dictionary.map((rank, i) => [rank, i]));
    const digits: number[] = [];
    let buffer = 0, remaining = 0;
    for (const rank of ranks) {
      buffer = buffer * 2 ** bits + indexOf.get(rank)!; remaining += bits;
      while (remaining >= 6) {
        remaining -= 6;
        digits.push(Math.floor(buffer / 2 ** remaining));
        buffer %= 2 ** remaining;
      }
    }
    if (remaining) digits.push(buffer * 2 ** (6 - remaining));
    const values = packUnsignedSlots(dictionary);
    const text = `${values.width}:${values.text}:${packUnsignedSlots(digits).text}`;
    if (text.length + 1 < packed.text.length) packed = { width: 11, text };
  }
  const positions = ranks.map((_, i) => i).filter(i => times[i] !== 0);
  const first = positions[0]!;
  const second = positions[1];
  const step = second === undefined ? 0 : (ranks[second]! - ranks[first]!) / (second - first);
  const start = ranks[first]! - step * first;
  const text = `${start},${step}`;
  if (Number.isSafeInteger(start) && Number.isSafeInteger(step)
      && positions.every(i => start + step * i === ranks[i])
      && text.length < packed.text.length) return {width: 0, text};
  return packed;
}

function slot(attacker: number, target: number): number {
  if (attacker === target)
    throw new Error("Dense hunt cannot target its attacker");
  return attacker < target ? attacker : attacker - 1;
}
const decodedBlocks = new WeakMap<DenseBlock, readonly number[]>();
function readBlock(state: Pick<CryptoBattleState, "teams">, block: DenseBlock) {
  const [target, generation, baseAtMs, width, text, orderWidth, orderText] = valuesOf(block);
  // The existing roster decoder rejects out-of-range and noncanonical indices.
  const targetTeamId = predictionTeam(state, String(target));
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Number.isSafeInteger(baseAtMs)
  )
    throw new Error("Invalid Dense hunt identity or time");
  let values = decodedBlocks.get(block);
  if (!values) {
    values = unpack(text, width);
    decodedBlocks.set(block, values);
  }
  if (values.length !== Object.keys(state.teams).length - 1)
    throw new Error("Dense hunt roster length changed");
  return { target, targetTeamId, generation, baseAtMs, values, ranks: readOrders(orderWidth, orderText, values) };
}

function appendDenseHunt(
  state: Pick<CryptoBattleState, "teams" | "huntLog" | "nowMs">,
  attackerTeamId: string,
  targetTeamId: string,
  generation: number,
  kind: DenseKind,
): readonly StoredHuntLogEntry[] {
  const atMs = state.nowMs;
  if (typeof atMs !== "number" || !Number.isSafeInteger(atMs))
    throw new Error("Dense hunt requires an exact match timestamp");
  const target = Number(predictionKey(state, targetTeamId));
  const attacker = Number(predictionKey(state, attackerTeamId));
  const previousIndex = indexLog(state.huntLog),
    key = denseKey(kind, target, generation);
  const index = previousIndex.dense.get(key) ?? -1;
  const old = index < 0 ? undefined : (state.huntLog[index] as DenseBlock);
  const decoded = old ? readBlock(state, old) : undefined;
  const baseAtMs = Math.min(decoded?.baseAtMs ?? atMs, atMs);
  const values = decoded
    ? decoded.values.map((value) =>
        value === 0 ? 0 : value + decoded.baseAtMs - baseAtMs,
      )
    : Array<number>(Object.keys(state.teams).length - 1).fill(0);
  const position = slot(attacker, target);
  if (values[position] !== 0)
    throw new Error("Dense success is already recorded");
  values[position] = atMs - baseAtMs + 1;
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error("Dense hunt time is outside the exact integer range");
  const rank = atMs === previousIndex.latestTime ? previousIndex.nextOrder
    : atMs > previousIndex.latestTime ? 0 : lastOrder(state.huntLog, atMs).nextOrder;
  const ranks = decoded ? [...decoded.ranks] : values.map(() => 0);
  ranks[position] = rank;
  const packedOrder = ranks.some(Boolean) ? packOrders(ranks, values) : undefined;
  const encoded = pack(values);
  const timeTuple = [
    target,
    generation,
    baseAtMs,
    encoded.width,
    encoded.text,
  ] as const;
  const tuple: ReturnType<typeof valuesOf> = packedOrder
    ? [...timeTuple, packedOrder.width, packedOrder.text] : timeTuple;
  const row: DenseBlock =
    kind === "rsa"
      ? { rsa: tuple }
      : kind === "rotor"
        ? { rotor: tuple }
        : kind === "share"
          ? { share: tuple }
          : { sudoku: tuple };
  const result =
    index < 0
      ? [...state.huntLog, row]
      : state.huntLog.map((entry, at) => (at === index ? row : entry));
  const nextIndex = {
    dense: index < 0 ? new Map([...previousIndex.dense, [key, state.huntLog.length]]) : previousIndex.dense,
    legacy: previousIndex.legacy,
    latestTime: Math.max(previousIndex.latestTime, atMs),
    nextOrder: atMs >= previousIndex.latestTime ? rank + 1 : previousIndex.nextOrder,
  };
  logIndexes.set(result, nextIndex);
  return result;
}

export function decodeHuntLog(
  state: Pick<CryptoBattleState, "teams" | "huntLog">,
): HuntLogEntry[] {
  const result: { entry: HuntLogEntry; rank: number }[] = [];
  for (const entry of state.huntLog) {
    if ("attackerTeamId" in entry) {
      result.push({entry, rank: 0});
      continue;
    }
    const { target, targetTeamId, generation, baseAtMs, values, ranks } = readBlock(
      state,
      entry,
    );
    for (let position = 0; position < values.length; position++) {
      const value = values[position]!;
      if (value === 0) continue;
      const atMs = baseAtMs + value - 1;
      if (typeof atMs !== "number" || !Number.isSafeInteger(atMs))
        throw new Error("Dense hunt timestamp exceeds the exact integer range");
      const attacker = position < target ? position : position + 1;
      result.push({ rank: ranks[position]!, entry: {
        attackerTeamId: predictionTeam(state, String(attacker)),
        targetTeamId,
        generation,
        atMs,
        ...(kindOf(entry) === "share"
          ? {}
          : { via: kindOf(entry) as "rsa" | "rotor" | "sudoku" }),
      }});
    }
  }
  return result.sort((a, b) => a.entry.atMs - b.entry.atMs || a.rank - b.rank).map(row => row.entry);
}

/** Same lossless representation and exact-time semantics for each distinct method. */
export function appendRsaHunt(
  state: CryptoBattleState,
  attacker: string,
  target: string,
  generation: number,
) {
  return appendDenseHunt(state, attacker, target, generation, "rsa");
}
export function appendRotorHunt(
  state: CryptoBattleState,
  attacker: string,
  target: string,
  generation: number,
) {
  return appendDenseHunt(state, attacker, target, generation, "rotor");
}

/** The lossless record supplies the once-per-generation guard, including legacy rows. */
export function hasRecordedHunt(
  state: Pick<CryptoBattleState, "teams" | "huntLog">,
  attackerId: string,
  targetId: string,
  generation: number,
  kind: DenseKind,
): boolean {
  const target = Number(predictionKey(state, targetId)),
    attacker = Number(predictionKey(state, attackerId));
  if (attacker === target) return false;
  const index = indexLog(state.huntLog);
  if (index.legacy.has(legacyKey(kind, attackerId, targetId, generation)))
    return true;
  const at = index.dense.get(denseKey(kind, target, generation));
  return (
    at !== undefined &&
    readBlock(state, state.huntLog[at] as DenseBlock).values[
      slot(attacker, target)
    ] !== 0
  );
}
export function hasRotorHunt(
  state: Pick<CryptoBattleState, "teams" | "huntLog">,
  attacker: string,
  target: string,
  generation: number,
): boolean {
  return hasRecordedHunt(state, attacker, target, generation, "rotor");
}
export function appendShareHunt(
  state: CryptoBattleState,
  attacker: string,
  target: string,
  generation: number,
) {
  return appendDenseHunt(state, attacker, target, generation, "share");
}
export function appendSudokuHunt(
  state: CryptoBattleState,
  attacker: string,
  target: string,
  generation: number,
) {
  return appendDenseHunt(state, attacker, target, generation, "sudoku");
}

/** Schema11 migration removes a duplicate guard only when its real timestamped
 * record exists. An old guard without a log is preserved; no time is invented. */
export function compactRecordedHunts(
  state: CryptoBattleState,
): Pick<CryptoBattleState, "huntLog" | "successfulHunts"> {
  const recorded = new Set<string>();
  const before = decodeHuntLog(state);
  let huntLog: readonly StoredHuntLogEntry[] = state.huntLog.filter(
    (entry) => !("attackerTeamId" in entry),
  );
  for (const entry of before) {
    if (entry.via === undefined)
      recorded.add(
        huntKey(entry.attackerTeamId, entry.targetTeamId, entry.generation),
      );
    if (entry.via === "rsa")
      recorded.add(
        rsaHuntKey(
          state,
          entry.attackerTeamId,
          entry.targetTeamId,
          entry.generation,
        ),
      );
    if (entry.via === "sudoku")
      recorded.add(
        JSON.stringify([
          "sudoku",
          entry.attackerTeamId,
          entry.targetTeamId,
          entry.generation,
        ]),
      );
  }
  for (const entry of state.huntLog)
    if ("attackerTeamId" in entry) {
      const source = { teams: state.teams, huntLog, nowMs: entry.atMs };
      huntLog = appendDenseHunt(
        source,
        entry.attackerTeamId,
        entry.targetTeamId,
        entry.generation,
        entry.via ?? "share",
      );
    }
  // Old object rows can encode an arbitrary insertion order within one exact
  // millisecond. The dense roster order cannot express every such permutation.
  // Keep that legacy audit unchanged rather than silently reorder its replay.
  const after = decodeHuntLog({ ...state, huntLog });
  if (
    before.some((entry, i) => {
      const next = after[i];
      return (
        !next ||
        entry.attackerTeamId !== next.attackerTeamId ||
        entry.targetTeamId !== next.targetTeamId ||
        entry.generation !== next.generation ||
        entry.atMs !== next.atMs ||
        entry.via !== next.via
      );
    })
  )
    huntLog = state.huntLog;
  return {
    huntLog,
    successfulHunts: compactSuccessfulHunts({
      ...state,
      successfulHunts: expandSuccessfulHunts(state).filter(
        (key) => !recorded.has(key),
      ),
    }),
  };
}
