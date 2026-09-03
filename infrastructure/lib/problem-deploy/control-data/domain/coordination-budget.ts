import type { SelectedBackend } from "../backend-config.js";

/**
 * [Issue #3151] How large one coordination state row is allowed to get, and
 * when the operator should hear about it.
 *
 * The whole plugin state goes into ONE row, and nothing measured it before this
 * module. On DynamoDB that meant a match could grow until a write simply
 * stopped being accepted — mid-tick, with no partial write to fall back on and
 * no warning that it was coming.
 *
 * ## Why the ceiling is not one number
 *
 * `CONTROL_DATA_BACKEND` is a runtime choice, and development currently runs
 * `turso`. The two backends fail for different reasons at different sizes:
 *
 *   - **DynamoDB** enforces a hard 400 KB per item and has no partial write.
 *     Crossing it stops the match.
 *   - **Turso / libSQL** has no comparable per-row ceiling. What actually bites
 *     is the size of each HTTP request and the latency of reading, modifying
 *     and writing the whole row on every operation.
 *
 * Hardcoding 400 KB would therefore be wrong in both directions at once: it
 * would not fire where DynamoDB actually breaks (the item is bigger than the
 * state alone), and it would cap Turso far below what that backend can serve.
 *
 * ## Why the size is a property of the game, not of the encoding
 *
 * `ac26-crypto-battle`'s measured worst case is 16.4 KB per team at 99 teams
 * (1.62 MB), about two thirds of which is the public ledger. That ledger is
 * permanent by design and grows with the number of teams playing. "Make the
 * state smaller" is therefore a request to make the game smaller, and the
 * platform is not the right place to ask for it. What the platform owes the
 * operator is the other half of the sentence: **on this backend, you have room
 * for this much**.
 */
export interface CoordinationStateBudget {
  /** Which backend this budget was derived for; echoed into logs and errors. */
  readonly backend: SelectedBackend["kind"];
  /**
   * Hard stop. A write whose serialized state exceeds this is refused by the
   * platform before it reaches the backend.
   */
  readonly maxBytes: number;
  /**
   * Early warning. Crossing this changes nothing about the write; it is the
   * signal that the match is on course to hit {@link maxBytes} while it is
   * still cheap to act on.
   */
  readonly warnBytes: number;
}

/**
 * DynamoDB's documented maximum item size (400 KB), the number this budget has
 * to stay under rather than the number it can hand out.
 */
const DYNAMODB_ITEM_LIMIT_BYTES = 400 * 1024;

/**
 * Room reserved inside {@link DYNAMODB_ITEM_LIMIT_BYTES} for everything in the
 * item that is not the plugin's state.
 *
 * Two distinct things are being covered, and both are why this is not a token
 * few hundred bytes:
 *
 *   - The item's other attributes — `PK`, `SK`, `version`, `updatedAt`,
 *     `expiresAt`, and the platform's schema envelope around `state`
 *     (`coordination-store.ts`). Small and boundable.
 *   - The gap between how this module measures and how DynamoDB measures.
 *     {@link serializedStateBytes} weighs the UTF-8 JSON text; DynamoDB weighs
 *     attribute names plus values in its own document encoding, which charges
 *     again for every key of every nested map and for each list element. For
 *     state shaped like these plugins' — arrays of small records with repeated
 *     short keys — that runs a few percent above the JSON text.
 *
 * 16 KiB is 4% of the item limit, which covers that spread for the state shapes
 * in this repository while costing a match nothing it can notice. The point of
 * the reserve is that the hard stop lands BELOW the real ceiling: being refused
 * by the platform is recoverable and legible, being refused by DynamoDB
 * mid-match is neither.
 */
const DYNAMODB_ROW_OVERHEAD_BYTES = 16 * 1024;

/**
 * The policy ceiling for the SQL backends (Turso / libSQL).
 *
 * Not a vendor limit — there is no per-row limit to quote. It is the size past
 * which reading, modifying and writing the entire row on every operation stops
 * being something a live match should be doing, and it is set to clear the
 * platform's own worst case with room to spare: 99 teams (the `teams.max(99)`
 * cap) of `ac26-crypto-battle` measure 1.62 MB, so 4 MiB leaves headroom for a
 * heavier problem without pretending the row can grow forever.
 *
 * Overridable per environment through `COORDINATION_STATE_MAX_BYTES` precisely
 * because it is policy rather than physics; the DynamoDB ceiling is not
 * overridable, because raising it past 400 KB would only move the failure from
 * this module back into the backend.
 */
const SQL_STATE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Fraction of the ceiling at which the operator is warned.
 *
 * Half, because the growth this is watching is roughly linear in team count and
 * in match length: a match that has used half its room by mid-event will use
 * the rest. Warning at 90% would be true and useless — there is no action left
 * that early enough to matter.
 */
const WARN_FRACTION = 0.5;

/** Environment override for the SQL ceiling. See {@link SQL_STATE_LIMIT_BYTES}. */
export const COORDINATION_STATE_MAX_BYTES_ENV = "COORDINATION_STATE_MAX_BYTES";

export interface CoordinationBudgetEnvironment {
  readonly [COORDINATION_STATE_MAX_BYTES_ENV]?: string;
}

/**
 * The budget for `backend`.
 *
 * A malformed or non-positive `COORDINATION_STATE_MAX_BYTES` throws rather than
 * falling back to the default. A typo there would otherwise silently restore
 * the very "no ceiling at all" state this issue exists to remove, and it would
 * do so in exactly the environment whose operator believed they had set one.
 */
export function coordinationStateBudget(
  backend: SelectedBackend,
  env: CoordinationBudgetEnvironment = {},
): CoordinationStateBudget {
  const maxBytes =
    backend.kind === "dynamodb"
      ? DYNAMODB_ITEM_LIMIT_BYTES - DYNAMODB_ROW_OVERHEAD_BYTES
      : (parseOverride(env[COORDINATION_STATE_MAX_BYTES_ENV]) ?? SQL_STATE_LIMIT_BYTES);
  return {
    backend: backend.kind,
    maxBytes,
    warnBytes: Math.floor(maxBytes * WARN_FRACTION),
  };
}

function parseOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new RangeError(
      `${COORDINATION_STATE_MAX_BYTES_ENV} must be a positive integer number of bytes, got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * How many bytes this state occupies once serialized.
 *
 * UTF-8 byte length of the JSON text, not `String.length`: a state carrying
 * Japanese labels — every problem in this catalog does — is up to three times
 * longer in bytes than in UTF-16 code units, and a ceiling measured in the
 * wrong unit is not a ceiling.
 *
 * `undefined` for a value JSON cannot represent (a cycle, a `BigInt`). The
 * caller treats that as "cannot be measured, so cannot be admitted": the write
 * would fail at the backend anyway, and guessing a size for it would be
 * inventing a number.
 */
export function serializedStateBytes(state: unknown): number | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(state);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  return Buffer.byteLength(json, "utf8");
}

export type CoordinationBudgetVerdict =
  /** Below the warning line. The overwhelming majority of writes. */
  | { readonly kind: "ok"; readonly bytes: number }
  /** Past the warning line, still writable. The write proceeds unchanged. */
  | { readonly kind: "warn"; readonly bytes: number; readonly budget: CoordinationStateBudget }
  /** Past the ceiling. The platform refuses the write. */
  | { readonly kind: "exceeded"; readonly bytes: number; readonly budget: CoordinationStateBudget }
  /**
   * Not serializable, so not measurable. Refused for the same reason as
   * `exceeded` — this is the platform declining to write something it cannot
   * account for, not the plugin being told its state is too big.
   */
  | { readonly kind: "unmeasurable"; readonly budget: CoordinationStateBudget };

/** Classifies one already-serialized size against `budget`. */
export function classifyCoordinationStateSize(
  bytes: number | undefined,
  budget: CoordinationStateBudget,
): CoordinationBudgetVerdict {
  if (bytes === undefined) return { kind: "unmeasurable", budget };
  if (bytes > budget.maxBytes) return { kind: "exceeded", bytes, budget };
  if (bytes >= budget.warnBytes) return { kind: "warn", bytes, budget };
  return { kind: "ok", bytes };
}

/** Convenience: measure and classify in one call. */
export function checkCoordinationStateSize(
  state: unknown,
  budget: CoordinationStateBudget,
): CoordinationBudgetVerdict {
  return classifyCoordinationStateSize(serializedStateBytes(state), budget);
}

/** Percentage of the ceiling used, rounded to one decimal, for log lines. */
export function budgetUsedPercent(bytes: number, budget: CoordinationStateBudget): number {
  return Math.round((bytes / budget.maxBytes) * 1000) / 10;
}

/**
 * [Issue #3169] What a problem declares about how its coordination state grows.
 *
 * ## Why the problem has to say, and the platform cannot work it out
 *
 * {@link checkCoordinationStateSize} is a runtime guard: it weighs the state a
 * write is carrying, right now. That is the correct last line of defence and
 * the wrong first one, because by the time it fires the event is running and
 * the participants are mid-match. The question an operator needs answered is
 * earlier and different — *will this event fit before I start it* — and nothing
 * the platform can see answers it. The size a match reaches is a property of
 * the game: how much each team accumulates, and how much of that is permanent.
 *
 * So the problem declares it, from a measurement rather than an estimate. In
 * `ac26-crypto-battle` that measurement already exists and is enforced by the
 * problem's own `state-size.test.ts`, which plays a full worst-case match; the
 * declaration is that test's numbers, and the test is what keeps them true.
 *
 * ## Linear because the measurement says it is
 *
 * `bytesPerTeam x teams + baseBytes` is a model, and a model the platform is
 * entitled to only because the problem is asked to prove it. The Battle's own
 * suite asserts the per-team cost stays linear (a super-linear term — anything
 * cross-team — would pass at four teams and blow up at ninety-nine), so the
 * extrapolation the platform performs here is the one the problem has tested.
 * A problem whose growth is not linear must not declare these fields; an
 * undeclared problem is simply not checked, which is the honest outcome.
 */
export interface CoordinationStateForecast {
  /** Serialized bytes the state gains per participating team, at worst case. */
  readonly bytesPerTeam: number;
  /** Serialized bytes the state occupies with no teams — config, seed, phase. */
  readonly baseBytes: number;
}

/** The state size this problem is expected to reach with `teamCount` teams. */
export function forecastCoordinationStateBytes(
  forecast: CoordinationStateForecast,
  teamCount: number,
): number {
  return forecast.baseBytes + forecast.bytesPerTeam * teamCount;
}

/**
 * The largest team count whose forecast still fits under `budget.maxBytes`.
 *
 * Returned so an operator is told what WOULD fit rather than only that their
 * number does not. "31 teams on this backend" is a decision they can act on;
 * "too big" sends them to read the source.
 */
export function maxTeamsForCoordinationBudget(
  forecast: CoordinationStateForecast,
  budget: CoordinationStateBudget,
): number {
  if (forecast.bytesPerTeam <= 0) return Number.POSITIVE_INFINITY;
  const room = budget.maxBytes - forecast.baseBytes;
  if (room <= 0) return 0;
  return Math.floor(room / forecast.bytesPerTeam);
}

export type CoordinationCapacityVerdict =
  | { readonly kind: "fits"; readonly forecastBytes: number }
  /**
   * Fits, but is forecast past the warning line — the same line a running match
   * crosses in {@link classifyCoordinationStateSize}. Reported before the event
   * runs so it is a scheduling decision rather than an alarm mid-match.
   */
  | {
      readonly kind: "tight";
      readonly forecastBytes: number;
      readonly maxTeams: number;
      readonly budget: CoordinationStateBudget;
    }
  | {
      readonly kind: "over";
      readonly forecastBytes: number;
      readonly maxTeams: number;
      readonly budget: CoordinationStateBudget;
    };

/**
 * Whether an event of `teamCount` teams can hold this problem on this backend.
 *
 * The whole point of #3151's per-backend budget stated ahead of play: DynamoDB
 * caps one item at 400 KB and has no partial write, so a match that outgrows it
 * stops dead with participants watching. Turso has no comparable per-row cap,
 * so the same event is fine there. Which of those an operator is about to walk
 * into is knowable before the event starts, and this is the function that knows
 * it.
 */
export function checkCoordinationCapacity(
  forecast: CoordinationStateForecast,
  teamCount: number,
  budget: CoordinationStateBudget,
): CoordinationCapacityVerdict {
  const forecastBytes = forecastCoordinationStateBytes(forecast, teamCount);
  const maxTeams = maxTeamsForCoordinationBudget(forecast, budget);
  if (forecastBytes > budget.maxBytes) return { kind: "over", forecastBytes, maxTeams, budget };
  if (forecastBytes >= budget.warnBytes) return { kind: "tight", forecastBytes, maxTeams, budget };
  return { kind: "fits", forecastBytes };
}

/**
 * Reads a problem's declared forecast out of its catalog entry.
 *
 * `undefined` for anything not fully and validly declared, and the caller then
 * performs no check at all. That is deliberate: every coordination problem that
 * exists today predates the declaration, and a platform that guessed a number
 * for them would either refuse events that are fine or admit ones that are not.
 * Silence means unmeasured, and unmeasured means unchecked — not "assumed
 * small".
 */
export function parseCoordinationStateForecast(
  declaration: unknown,
): CoordinationStateForecast | undefined {
  if (typeof declaration !== "object" || declaration === null) return undefined;
  const budget = (declaration as { stateBudget?: unknown }).stateBudget;
  if (typeof budget !== "object" || budget === null) return undefined;
  const { bytesPerTeam, baseBytes } = budget as Record<string, unknown>;
  if (!isPositiveInteger(bytesPerTeam) || !isNonNegativeInteger(baseBytes)) return undefined;
  return { bytesPerTeam, baseBytes };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
