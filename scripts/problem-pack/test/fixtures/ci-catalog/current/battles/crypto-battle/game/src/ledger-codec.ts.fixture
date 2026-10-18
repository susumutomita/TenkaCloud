/** Lossless persistent Public Ledger codec. The participant/replay object stays
 * unchanged. Schemas 2–10 use short-key objects; schema11 writes fixed tuples
 * and references team IDs through the match's existing sorted immutable roster.
 * No entry, value, exact millisecond, ID or array order is removed. Unfamiliar
 * artifact/Order IDs use literal escapes rather than a guessed derivation.
 *
 * Reducers retain this compact representation between every platform write.
 * artifactFields expands one entry for trusted scans; decodeArtifact/decodeLedger
 * expand public IDs at participant projection and replay boundaries. Neither
 * reader needs a retained Contract: a completed Order may have left the queue.
 */

import { rosterOf } from "./hunt-key.ts";
import type { CipherRung } from "./ladder.ts";
import type { SubmissionMethod } from "./methods.ts";
import type {
  CipherPairArtifact,
  CiphertextArtifact,
  CryptoBattleState,
  PartialArtifact,
  ProofArtifact,
  PublicArtifact,
  ShareArtifact,
  SudokuRevealArtifact,
} from "./types.ts";

/**
 * Fields every `StoredArtifact` kind carries, PLUS the `d` escape hatch.
 *
 * `d` is never set by `encodeArtifact` below when {@link deriveArtifactId}
 * reconstructs the entry's real `PublicArtifact.id` exactly -- which, as of
 * this module, is every kind reducer.ts constructs (see `deriveArtifactId`'s
 * doc comment for how that was verified, and `ledger-codec.test.ts`'s "no
 * entry needs `d`" test, which re-checks it live against every artifact a
 * real match produces, not just this comment's claim). It exists so a FUTURE
 * id template change in reducer.ts that this module's derivation formula
 * does not know about fails safe -- the id is kept, never silently dropped
 * (Issue #679's design doc: "推測で落とさないこと"). Encoded as `d` (short:
 * this is the rare-to-never path, so it still pays the compact-key rent),
 * and NEVER written as `d: undefined` -- `encodeArtifact` uses a conditional
 * spread specifically so an absent id-mismatch never becomes a present
 * `undefined` key (which would make `JSON.stringify` round-trips and
 * `toEqual` disagree about whether the field exists).
 */
interface StoredArtifactBase {
  readonly tm: string | number;
  /** Schema 4: N reconstructs `${tm}-c${N}`; older/unfamiliar IDs stay strings. */
  readonly c: string | number;
  readonly g: number;
  readonly m: SubmissionMethod;
  readonly t: number;
  readonly d?: string;
}

export interface StoredShareArtifact extends StoredArtifactBase {
  readonly k: "share";
  readonly i: number;
  readonly v: string;
}

export interface StoredCipherPairArtifact extends StoredArtifactBase {
  readonly k: "cipher-pair";
  readonly r: CipherRung;
  readonly kp?: number;
  readonly p: readonly number[];
  readonly x: readonly number[];
}

interface StoredRsaPairArtifact extends StoredArtifactBase {
  readonly k: "rsa-pair";
  readonly n: number;
  readonly e: number;
  readonly p: number;
  readonly x: number;
}

export interface StoredProofArtifact extends StoredArtifactBase {
  readonly y?: string;
  readonly k: "proof";
  readonly o: string;
  /** [Issue #701] The challenge `e`. Absent on a row written before #701. */
  readonly e?: string;
  readonly z: string;
}

export interface StoredCiphertextArtifact extends StoredArtifactBase {
  readonly k: "ciphertext";
  readonly r: string;
  readonly y: string;
}

export interface StoredPartialArtifact extends StoredArtifactBase {
  readonly k: "partial";
  readonly v: string;
  readonly pp: readonly string[];
  readonly s: string;
}

/** [Issue #709] One opened group of a relabelled sudoku grid. */
export interface StoredSudokuRevealArtifact extends StoredArtifactBase {
  readonly k: "sudoku-reveal";
  readonly gr: number;
  readonly cl: readonly number[];
  readonly tg: string;
}

/**
 * `CryptoBattleState.publicLedger`'s actual element type -- see this file's
 * header. One variant per `PublicArtifact` kind, discriminated on `k` the
 * same way `PublicArtifact` discriminates on `kind`.
 */
interface StoredRpsCommit extends StoredArtifactBase {
  readonly k: "rps-commit";
  readonly du: string;
  readonly v: number;
}
interface StoredRpsOpen extends StoredArtifactBase {
  readonly k: "rps-open";
  readonly du: string;
  readonly v: number;
  readonly h: 1 | 2 | 3;
  readonly r: number;
}

interface StoredRotorPair extends StoredArtifactBase {
  readonly k: "rotor-pair";
  readonly p: readonly number[];
  readonly x: readonly number[];
}

export type StoredArtifact =
  | StoredRotorPair
  | StoredRsaPairArtifact
  | StoredRpsCommit
  | StoredRpsOpen
  | StoredShareArtifact
  | StoredCipherPairArtifact
  | StoredProofArtifact
  | StoredCiphertextArtifact
  | StoredPartialArtifact
  | StoredSudokuRevealArtifact;

/** Schema 11 tuple order is stable. Null is only an absent optional field. */
export type StoredArtifactTuple = readonly [
  number,
  string | number,
  string | number,
  number,
  number,
  number,
  ...unknown[],
];
export type PersistedArtifact = StoredArtifact | StoredArtifactTuple;
// Append new kinds/methods only: existing indices are a persisted schema contract.
const TUPLE_FIELDS = {
  share: ["i", "v"],
  "cipher-pair": ["r", "kp", "p", "x"],
  "rotor-pair": ["p", "x"],
  "rsa-pair": ["n", "e", "p", "x"],
  proof: ["o", "e", "z"],
  ciphertext: ["r", "y"],
  partial: ["v", "pp", "s"],
  "sudoku-reveal": ["gr", "cl", "tg"],
  "rps-commit": ["du", "v"],
  "rps-open": ["du", "v", "h", "r"],
  "schnorr-proof": ["o", "e", "z", "y"],
} as const;
const TUPLE_KINDS = Object.keys(TUPLE_FIELDS) as (keyof typeof TUPLE_FIELDS)[];
const TUPLE_METHODS: readonly SubmissionMethod[] = [
  "leak",
  "prove",
  "cipher",
  "fhe",
  "mpc",
  "duel",
];
const tupleCache = new WeakMap<StoredArtifactTuple, StoredArtifact>();
/** Expand stored fields without changing team IDs, constructing public IDs or scanning the ledger. */
export function artifactFields(entry: PersistedArtifact): StoredArtifact {
  if (!Array.isArray(entry)) return entry as StoredArtifact;
  const tuple = entry as StoredArtifactTuple;
  const cached = tupleCache.get(tuple);
  if (cached) return cached;
  const [kind, tm, c, g, method, t] = tuple;
  const rawKind = Number.isInteger(kind) ? TUPLE_KINDS[kind] : undefined;
  const schnorr = rawKind === "schnorr-proof";
  const k = rawKind === "schnorr-proof" ? "proof" : rawKind;
  const fieldsForKind = schnorr ? ["o", "e", "z", "y"] : k ? TUPLE_FIELDS[k] : [];
  const m = Number.isInteger(method) ? TUPLE_METHODS[method] : undefined;
  if (
    !k ||
    !m ||
    tuple.length < 6 + fieldsForKind.length ||
    tuple.length > 7 + fieldsForKind.length
  )
    throw new Error("Invalid ledger tuple shape");
  const result: Record<string, unknown> = { k, tm, c, g, m, t };
  for (const [i, field] of fieldsForKind.entries()) {
    const value = tuple[6 + i];
    if (value === null) {
      if (
        !(k === "proof" && field === "e") &&
        !(k === "cipher-pair" && field === "kp")
      )
        throw new Error("Missing required ledger tuple value");
    } else result[field] = value;
  }
  if (tuple.length === 7 + fieldsForKind.length) {
    const d = tuple.at(-1);
    if (typeof d !== "string") throw new Error("Invalid escaped ledger ID");
    result.d = d;
  }
  const fields = result as unknown as StoredArtifact;
  tupleCache.set(tuple, fields);
  return fields;
}
function tupleArtifact(fields: StoredArtifact): StoredArtifactTuple {
  // A new tag preserves schema11 proof tuples, including escaped IDs.
  const schnorr = fields.k === "proof" && fields.y !== undefined;
  const kind = schnorr ? TUPLE_KINDS.indexOf("schnorr-proof") : TUPLE_KINDS.indexOf(fields.k),
    method = TUPLE_METHODS.indexOf(fields.m);
  if (kind < 0 || method < 0)
    throw new Error("Unknown ledger tuple discriminant");
  const values = (schnorr ? ["o", "e", "z", "y"] : TUPLE_FIELDS[fields.k]).map(
    (key) => (fields as unknown as Record<string, unknown>)[key] ?? null,
  );
  return [
    kind,
    fields.tm,
    fields.c,
    fields.g,
    method,
    fields.t,
    ...values,
    ...(fields.d === undefined ? [] : [fields.d]),
  ];
}

/** Schema 4 preserves unfamiliar IDs verbatim and shortens exact Order IDs. */
type Teams = CryptoBattleState["teams"];
/** Schema11 references the existing fixed roster; old literal IDs remain exact. */
export function storedTeamId(
  entry: Pick<StoredArtifact, "tm"> | StoredArtifactTuple,
  teams?: Teams,
): string {
  const stored = Array.isArray(entry)
    ? artifactFields(entry as StoredArtifactTuple)
    : (entry as Pick<StoredArtifact, "tm">);
  if (typeof stored.tm === "string") return stored.tm;
  if (!teams || !Number.isSafeInteger(stored.tm) || stored.tm < 0)
    throw new Error("Invalid or missing ledger team roster");
  const id = rosterOf(teams).ids[stored.tm];
  if (id === undefined)
    throw new Error("Ledger team is outside the fixed roster");
  return id;
}
export function contractId(
  entry: Pick<StoredArtifact, "c" | "tm"> | StoredArtifactTuple,
  teams?: Teams,
): string {
  const stored = Array.isArray(entry)
    ? artifactFields(entry as StoredArtifactTuple)
    : (entry as Pick<StoredArtifact, "c" | "tm">);
  return typeof stored.c === "number"
    ? `${storedTeamId(stored, teams)}-c${stored.c}`
    : stored.c;
}

export function compactContractId(
  teamId: string,
  id: string | number,
): string | number {
  if (typeof id === "number") return id;
  const prefix = `${teamId}-c`;
  const n = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && `${prefix}${n}` === id ? n : id;
}

/** Immutable completion arrays share the ledger codec; cache avoids rescanning a
 * completed match's whole history on every subsequent HUNT. Unknown IDs stay exact. */
const completedIdCache = new WeakMap<
  readonly (string | number)[],
  { teamId: string; ids: readonly (string | number)[] }
>();
export function compactCompletedContractIds(
  teamId: string,
  ids: readonly (string | number)[],
): readonly (string | number)[] {
  const cached = completedIdCache.get(ids);
  if (cached?.teamId === teamId) return cached.ids;
  const compact = ids.map((id) => compactContractId(teamId, id));
  const result = compact.every((id, at) => id === ids[at]) ? ids : compact;
  completedIdCache.set(ids, { teamId, ids: result });
  completedIdCache.set(result, { teamId, ids: result });
  return result;
}

/**
 * Reconstructs `PublicArtifact.id` from a `StoredArtifact` that carries no
 * `d` -- the whole reason `id` can be dropped from the persisted form at
 * all. Each arm below is copied from the ONE place in reducer.ts that ever
 * builds that kind's `id` (verified by reading, not inferred):
 *
 *   - "share":       reducer.ts `applyLeak`        -- `` `${contract.id}-share${shareIndex}` ``
 *   - "cipher-pair": reducer.ts `applyLadderLeak`   -- `` `${contract.id}-pair` ``
 *   - "proof":       (legacy, decode-only since #709; was reducer.ts `applyProve`) -- `` `${contract.id}-proof` ``
 *   - "ciphertext":  reducer.ts `applyFhe`           -- `` `${contract.id}-ciphertext` ``
 *   - "partial":     reducer.ts `applyMpc`           -- `` `${contract.id}-partial` ``
 *   - "sudoku-reveal": reducer.ts `applyProveSudoku` -- `` `${contract.id}-sudoku` `` (#709)
 *
 * Every one of these five is the ONLY construction site for its
 * `PublicArtifact` kind in `game/src` (confirmed: `grep -n 'kind: "<kind>"'
 * across game/src/*.ts, non-test, returns exactly one hit per kind, all in
 * reducer.ts) -- so there is exactly one template to match per kind, not a
 * family of call sites that could disagree with each other. Whether any of
 * these five templates ever CHANGED in the past (a `git log -S` question)
 * was not checked, and does not matter for correctness either way: an
 * in-flight v1 row an id template changed under would still migrate cleanly,
 * because `encodeArtifact`'s live comparison (see below) keeps `d` on any
 * entry whose real id does not match this function's current formula --
 * nothing from before this module existed can silently lose its id, whether
 * or not the template ever moved.
 */
function deriveArtifactId(stored: StoredArtifact, teams?: Teams): string {
  switch (stored.k) {
    case "rps-commit":
      return `${contractId(stored, teams)}-rps-commit`;
    case "rps-open":
      return `${contractId(stored, teams)}-rps-open`;
    case "share":
      return `${contractId(stored, teams)}-share${stored.i}`;
    case "rotor-pair":
    case "rsa-pair":
    case "cipher-pair":
      return `${contractId(stored, teams)}-pair`;
    case "proof":
      return `${contractId(stored, teams)}-proof`;
    case "ciphertext":
      return `${contractId(stored, teams)}-ciphertext`;
    case "partial":
      return `${contractId(stored, teams)}-partial`;
    case "sudoku-reveal":
      return `${contractId(stored, teams)}-sudoku`;
    default: {
      const exhaustive: never = stored;
      throw new Error(
        `deriveArtifactId: unknown stored artifact ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * One `PublicArtifact` -> its persisted `StoredArtifact` form. See this
 * file's header for the key map.
 *
 * `derivedId`'s comparison against `artifact.id` is the live half of this
 * module's "never drop an id we cannot reconstruct" guarantee: it runs on
 * EVERY artifact this package ever encodes, not just in a test.
 */
export function encodeArtifact(artifact: PublicArtifact): StoredArtifact;
export function encodeArtifact(
  artifact: PublicArtifact,
  teams: Teams,
): StoredArtifactTuple;
export function encodeArtifact(
  artifact: PublicArtifact,
  teams?: Teams,
): PersistedArtifact {
  const tm = teams
    ? rosterOf(teams).positions.get(artifact.teamId)
    : artifact.teamId;
  if (tm === undefined)
    throw new Error("Artifact references a team outside the match");
  const base = {
    tm,
    c: compactContractId(artifact.teamId, artifact.contractId),
    g: artifact.generation,
    m: artifact.method,
    t: artifact.postedAtMs,
  };
  let withoutId: StoredArtifact;
  switch (artifact.kind) {
    case "rotor-pair":
      withoutId = {
        ...base,
        k: "rotor-pair",
        p: artifact.plaintext,
        x: artifact.ciphertext,
      };
      break;
    case "rsa-pair":
      withoutId = {
        ...base,
        k: "rsa-pair",
        n: artifact.n,
        e: artifact.e,
        p: artifact.plaintext,
        x: artifact.ciphertext,
      };
      break;
    case "rps-commit":
      withoutId = {
        ...base,
        k: artifact.kind,
        du: artifact.duelId,
        v: artifact.commitment,
      };
      break;
    case "rps-open":
      withoutId = {
        ...base,
        k: artifact.kind,
        du: artifact.duelId,
        v: artifact.commitment,
        h: artifact.hand,
        r: artifact.randomness,
      };
      break;
    case "share":
      withoutId = {
        ...base,
        k: "share",
        i: artifact.shareIndex,
        v: artifact.value,
      };
      break;
    case "cipher-pair":
      withoutId = {
        ...base,
        k: "cipher-pair",
        r: artifact.rung,
        ...(artifact.keyPosition === undefined
          ? {}
          : { kp: artifact.keyPosition }),
        p: artifact.plaintext,
        x: artifact.ciphertext,
      };
      break;
    case "proof":
      withoutId = {
        ...base,
        k: "proof",
        o: artifact.commitment,
        ...(artifact.publicKey === undefined ? {} : { y: artifact.publicKey }),
        ...(artifact.challenge === undefined ? {} : { e: artifact.challenge }),
        z: artifact.response,
      };
      break;
    case "ciphertext":
      withoutId = { ...base, k: "ciphertext", r: artifact.r, y: artifact.y };
      break;
    case "partial":
      withoutId = {
        ...base,
        k: "partial",
        v: artifact.partial,
        pp: artifact.peerPartials,
        s: artifact.total,
      };
      break;
    case "sudoku-reveal":
      withoutId = {
        ...base,
        k: "sudoku-reveal",
        gr: artifact.group,
        cl: artifact.cells,
        tg: artifact.tag,
      };
      break;
    default: {
      const exhaustive: never = artifact;
      throw new Error(
        `encodeArtifact: unknown artifact ${JSON.stringify(exhaustive)}`,
      );
    }
  }
  const derivedId = deriveArtifactId(withoutId, teams);
  const fields =
    derivedId === artifact.id ? withoutId : { ...withoutId, d: artifact.id };
  return teams ? tupleArtifact(fields) : fields;
}

/** `readonly PublicArtifact[]` -> `StoredArtifact[]`, entry by entry. */
export function encodeLedger(
  entries: readonly PublicArtifact[],
): StoredArtifact[];
export function encodeLedger(
  entries: readonly PublicArtifact[],
  teams: Teams,
): PersistedArtifact[];
export function encodeLedger(
  entries: readonly PublicArtifact[],
  teams?: Teams,
): PersistedArtifact[] {
  return entries.map((entry) =>
    teams ? encodeArtifact(entry, teams) : encodeArtifact(entry),
  );
}

/** One `StoredArtifact` -> the `PublicArtifact` it was encoded from. */
export function decodeArtifact(
  entry: PersistedArtifact,
  teams?: Teams,
): PublicArtifact {
  const stored = artifactFields(entry);
  const id = stored.d ?? deriveArtifactId(stored, teams);
  const { g: generation, m: method, t: postedAtMs } = stored;
  const teamId = storedTeamId(stored, teams);
  const decodedContractId = contractId(stored, teams);
  switch (stored.k) {
    case "rotor-pair":
      return {
        id,
        kind: "rotor-pair",
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        plaintext: stored.p,
        ciphertext: stored.x,
      };
    case "rsa-pair":
      return {
        id,
        kind: "rsa-pair",
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        n: stored.n,
        e: stored.e,
        plaintext: stored.p,
        ciphertext: stored.x,
      };
    case "rps-commit":
      return {
        id,
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        kind: stored.k,
        duelId: stored.du,
        commitment: stored.v,
      };
    case "rps-open":
      return {
        id,
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        kind: stored.k,
        duelId: stored.du,
        commitment: stored.v,
        hand: stored.h,
        randomness: stored.r,
      };
    case "share":
      return {
        id,
        kind: "share",
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        shareIndex: stored.i,
        value: stored.v,
      };
    case "cipher-pair":
      return {
        id,
        kind: "cipher-pair",
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        rung: stored.r,
        ...(stored.kp === undefined ? {} : { keyPosition: stored.kp }),
        plaintext: stored.p,
        ciphertext: stored.x,
      } satisfies CipherPairArtifact;
    case "proof":
      return {
        id,
        kind: "proof",
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        commitment: stored.o,
        ...(stored.y === undefined ? {} : { publicKey: stored.y }),
        ...(stored.e === undefined ? {} : { challenge: stored.e }),
        response: stored.z,
      } satisfies ProofArtifact;
    case "ciphertext":
      return {
        id,
        kind: "ciphertext",
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        r: stored.r,
        y: stored.y,
      } satisfies CiphertextArtifact;
    case "partial":
      return {
        id,
        kind: "partial",
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        partial: stored.v,
        peerPartials: stored.pp,
        total: stored.s,
      } satisfies PartialArtifact;
    case "sudoku-reveal":
      return {
        id,
        kind: "sudoku-reveal",
        teamId,
        contractId: decodedContractId,
        generation,
        method,
        postedAtMs,
        group: stored.gr,
        cells: stored.cl,
        tag: stored.tg,
      } satisfies SudokuRevealArtifact;
    default: {
      const exhaustive: never = stored;
      throw new Error(
        `decodeArtifact: unknown stored artifact ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** `readonly StoredArtifact[]` -> `PublicArtifact[]`, entry by entry. */
export function decodeLedger(
  stored: readonly PersistedArtifact[],
  teams?: Teams,
): PublicArtifact[] {
  return stored.map((entry) => decodeArtifact(entry, teams));
}

/**
 * [TenkaCloud Issue #3150] Lifts a v1-schema `CryptoBattleState` (the shape
 * this package wrote before this module existed: `publicLedger` as full
 * `PublicArtifact[]`) to v2 (`publicLedger` as `StoredArtifact[]`).
 *
 * The v1 -> v2 step of `reducer.ts`'s `migrateState` (the plugin's
 * `migrateState`; `stateSchemaVersion` is 3 since #709) -- see that file, and
 * `coordination/crypto-battle.ts`, and TenkaCloud's
 * `packages/coordination-plugin-sdk/src/index.ts` for the platform contract
 * this fulfills: `migrateState` is REQUIRED once `stateSchemaVersion` is
 * declared (a plugin that skips it is rejected at load, before any row is
 * touched), must be a pure function of `(state, fromVersion)` with no `ctx`,
 * and a thrown error must leave the row completely untouched (no
 * `initialState`, no write, no reset) rather than risk repairing it wrong --
 * so this function THROWS on anything it does not recognize instead of
 * trying to patch it up. It performs exactly one transformation --
 * `publicLedger: encodeLedger(v1.publicLedger)` -- and spreads every other
 * field unchanged; it is deliberately not where Contract-shape repairs
 * happen (that is `tick()`'s own job, see `migration.test.ts`), so a
 * migration failure and a self-repair failure are never the same failure.
 *
 * The one case this package can actually be asked to migrate is
 * `fromVersion === 1` (there has never been a schema version before this
 * one), so that is the only case handled; anything else throws rather than
 * guess at an intermediate shape nothing ever wrote.
 */
/**
 * `method` の無い #650 以前の artifact に `method` を戻す。
 *
 * `PublicArtifact.method` は #650 (`3838e52`, 2026-08-30) で入りました。 それ以前に書かれた行の
 * share / proof はこのフィールドを持ちません。 型の上では必須なので素通りしますが、 portal は
 * `entry.method === "leak" && entry.kind === "share"` で「晒された share」を判定しており
 * (`portal/GameBoard.tsx`)、 `undefined` は `protected` 側に落ちます -- **晒したはずの share が
 * 守られているように見える**。 行の TTL は 7 日なので、 #650 の直後しばらくはこの形の行が実在します。
 *
 * 補完は推測ではありません。 `method` を欠きうる kind は `share` (#490) と `proof` (#492) だけで、
 * `cipher-pair` (#661) / `ciphertext` / `partial` (#651) はいずれも #650 より後に入っています。
 * そして #650 以前は share の出所が LEAK、 proof の出所が PROVE の 1 経路ずつしかありません。
 *
 * ここ (移行) でだけ行い、 `encodeArtifact` は忠実なままにしてあります。 encode は「今ある値を
 * そのまま書く」のが仕事で、 古い形の解釈は移行の仕事だからです。
 */
function normalizePreMethodArtifact(artifact: PublicArtifact): PublicArtifact {
  if ((artifact as { readonly method?: unknown }).method !== undefined)
    return artifact;
  if (artifact.kind === "share") return { ...artifact, method: "leak" };
  if (artifact.kind === "proof") return { ...artifact, method: "prove" };
  return artifact;
}

export function migrateStateV1(
  state: unknown,
  fromVersion: number,
): CryptoBattleState {
  if (fromVersion !== 1) {
    throw new Error(
      `ledger-codec: migrateStateV1 cannot migrate from schema version ${fromVersion} (only v1 -> v2 is defined)`,
    );
  }
  if (typeof state !== "object" || state === null) {
    throw new Error(
      "ledger-codec: migrateStateV1 received a non-object v1 state",
    );
  }
  const v1 = state as { readonly publicLedger?: unknown } & Record<
    string,
    unknown
  >;
  if (!Array.isArray(v1.publicLedger)) {
    throw new Error(
      "ledger-codec: migrateStateV1: v1 state is missing a publicLedger array",
    );
  }
  return {
    ...v1,
    publicLedger: encodeLedger(
      (v1.publicLedger as readonly PublicArtifact[]).map(
        normalizePreMethodArtifact,
      ),
    ),
  } as unknown as CryptoBattleState;
}
