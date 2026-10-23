import { initialSteal, stealTask, validateSteal, applySteal, projectSteal } from "./score-steal.ts";
import { curriculumPlan } from "./curriculum.ts";
import { evolutionTask, evolutionAnswer, parseEvolutionAnswer } from "./evolution.ts";
import { MATCH_PACING, pacingConfig } from "./pacing.ts";
import { startedTiming, waitingRemainingMs, withMatchDuration } from "./match-length.ts";
import { deriveBigInt } from "./prng.ts";
import {anamorphicTask,anamorphicAnswer,parseAnamorphicAnswer} from "./anamorphic.ts";
import {starkTask,starkAnswer,parseStarkAnswer} from "./stark.ts";
import {ioTask,ioAnswer,parseIoAnswer} from "./io.ts";
import {constraintTask, constraintResiduals, parseResiduals} from "./snark.ts";
import {addPoints,parsePoint,CURVE_POINTS} from "./ec.ts";
import { createHmac } from "node:crypto";
import { power, group, scalar, verifySchnorr } from "./schnorr.ts";
import { artifactFields } from "./ledger-codec.ts";
import { hasSuccessfulHunt, recordSuccessfulHunt } from "./hunt-success.ts";
import { storeLastHunt, readLastHunt } from "./hunt-result.ts";
import { rsaHuntKey, pruneRetiredRsaHunts } from "./hunt-key.ts";
/**
 * Pure game model for the PROVE / LEAK / HUNT / ROTATE Battle (Issue #486, PR1-PR3).
 *
 * `initialState` / `validateOp` / `applyOp` / `tick` / `projectForTeam` below
 * are plain functions with the exact shape a `@tenkacloud/coordination-plugin-sdk`
 * CoordinationPlugin needs (see ADR-028's description of `interTeamCoordination`
 * in SCHEMA.json): the platform's dispatcher Lambda drives a single tenant/event
 * row through validate -> apply -> project. That SDK package is NOT a dependency
 * of this repository (TenkaCloudChallenge owns problem content, not platform
 * packages) and is deliberately never imported here -- `coordination/crypto-battle.ts`
 * (PR3) wires these exports into a thin plugin file, without reshaping them.
 *
 * Trust model: this whole `game/` package runs only on the trusted side (the
 * platform dispatcher). `TeamState.secret` / `TeamState.shares` are real
 * cryptographic material and this reducer computes with them directly -- that
 * is safe *only* because a participant never receives raw `CryptoBattleState`,
 * only what `projectForTeam` redacts down to (see that function, and
 * adversarial test #5).
 *
 * WIRE BOUNDARY (Issue #486 PR3 review fix): `validateOp` below IS the
 * boundary that turns a participant's untrusted request into something this
 * reducer trusts -- there is no separate parsing layer upstream. The
 * coordination plugin (`coordination/crypto-battle.ts`) is a bare passthrough
 * (`dispatchOp` calls `validateOp` directly on whatever arrived as
 * JSON-parsed `unknown` off the wire; TenkaCloud's `CoordinationOpBodySchema`
 * is `{ op: z.unknown() }`, no shape validation happens before this package
 * ever sees `op`), and `CryptoBattleState` itself has to survive a real
 * database round-trip between calls (Turso / DynamoDB -- see
 * `CryptoBattleOp` / `CryptoBattleState`'s "JSON-SAFETY INVARIANT" in
 * types.ts). Concretely: `CryptoBattleOp`'s hunt variant carries
 * `recoveredSecret` as a string, and `validateOp`'s "hunt" branch parses it
 * with `decimal.ts`'s `parseCanonicalDecimal` -- the one untrusted-decimal
 * gate -- and rejects a malformed value with `{ ok: false }` instead of a
 * `mod()` call throwing on a non-bigint value it was never guaranteed to
 * receive. A sudoku grid on the wire is checked the same way, by shape
 * (`isFullGridShape`) before anything reads a cell.
 *
 * Purity contract (see adversarial tests #7 / #8):
 *   - `applyOp` and `tick` never mutate the `state` they are given; they return
 *     a new value built entirely from immutable updates (object/array spreads).
 *   - No function under src/ reads `Date.now()`, `Math.random()`, or any other
 *     ambient/non-deterministic source. The only "time" a reducer ever sees is
 *     `tick`'s explicit `eventNowMs` argument; the only "randomness" is derived
 *     from `state.seed` via prng.ts.
 *   - Given the same seed and the same ordered sequence of tick/op calls, two
 *     independent replays produce deeply-equal state, always.
 *
 * PROVE (PR2, rebuilt in #709) is the ZK sudoku proof: `applyProveSudoku`
 * derives the team's own solution from the seed, checks the submitted grid is
 * a relabelling of it, and publishes one row, column or box of the SUBMITTED
 * grid -- never of the solution. See sudoku.ts for the scheme.
 */

import {
  type ContractPlan,
  deriveRsaKey,
  deriveRsaPlaintext,
  deriveCipherKey,
  deriveContractPlan,
  derivePermutationTag,
  derivePlaintext,
  deriveRevealGroup,
  deriveSudokuPuzzle,
  deriveSudokuSolution,
  deriveTeamGeneration,
  type FieldConfig,
} from "./fixtures.ts";
import { deriveRotorPositions, deriveRotorPlaintext } from "./fixtures.ts";
import { huntCount, changeHuntCount, packHuntAttempts } from "./hunt-budget.ts";
import { appendRotorHunt, hasRotorHunt, hasRecordedHunt, appendShareHunt, appendSudokuHunt, compactRecordedHunts } from "./hunt-log.ts";
import { rotorEncrypt, parseRotorAnswer, rotorValue } from "./rotor.ts";
import { parseRsaAnswer, rsaEncrypt, rsaFactorsFit } from "./rsa.ts";
import { applyRpsHunt, projectRpsHunt, validateRpsHunt } from "./rps-hunt.ts";
import { appendRsaHunt } from "./hunt-log.ts";
import { huntKey, storedHuntKey, compactHuntAttempts, validateStoredHuntAttempts, pruneRetiredHuntAttempts } from "./hunt-key.ts";
import { applyRps, expireRps, pairTeams, projectRps, validateRps } from "./rps.ts";
import { parseCanonicalDecimal } from "./decimal.ts";
import { decryptOrderSum, deriveFheOrderInputs, expectedFheSum } from "./fhe.ts";
import { awardBooster, boosterStartAt, projectBooster, storedBooster } from "./booster.ts";
import { awardLightning, storedLightning, settleLightning, projectLightning, lightningEligible, lightningBonus, armLightning } from "./lightning.ts";
import { type HintContext, hintCostAt, hintsFor } from "./hints.ts";
import {
  type CipherRung,
  ALL_CIPHER_RUNGS,
  encryptWithRung,
  exposedKeyPositions,
  isCipherRung,
  validCipherKey,
  parseAnswer,
  rungSpec,
  toSymbols,
} from "./ladder.ts";
import {
  allPartials,
  deriveMpcPrivateInputs,
  expectedMpcPartial,
  MPC_PARTY_COUNT,
  MPC_TEAM_PARTY_INDEX,
  sumInField,
} from "./mpc.ts";
import {
  allowedMethodsFor,
  methodCanPerformTask,
  type PrivacyConstraint,
  type SubmissionMethod,
} from "./methods.ts";
import { HAND_PRIME, mod } from "./field.ts";
import { storedTeamId, compactCompletedContractIds, compactContractId, contractId, decodeArtifact, decodeLedger, encodeArtifact, encodeLedger, migrateStateV1 } from "./ledger-codec.ts";
import {
  ALL_PERMUTATIONS,
  CONSTRAINT_GROUPS,
  IDENTITY_PERMUTATION,
  isFullGridShape,
  isValidSolution,
  type OpenedGroup,
  type Permutation,
  permutationBetween,
  recoverableSolutions,
  samePermutation,
  type SudokuGrid,
} from "./sudoku.ts";
import type {
  CipherPairArtifact,
  CiphertextArtifact,
  Contract,
  CoordinationContext,
  CoordinationTiming,
  CryptoBattleConfig,
  CryptoBattleOp,
  CryptoBattleProjection,
  CryptoBattleState,
  HintProjection,
  HuntBudgetProjection,
  OrderTask,
  OrderTaskProjection,
  PartialArtifact,
  Phase,
  PublicArtifact,
  StoredCiphertext,
  StoredShare,
  SudokuRevealArtifact,
  TeamState,
  TeamSummaryProjection,
  ValidateResult,
  VaultProjection,
} from "./types.ts";

/**
 * Issue #486 playtest seed values. Not a locked-in balance spec -- see
 * `CryptoBattleConfig`'s doc comment in types.ts. `prime` is stringified, not
 * a bigint, per types.ts's "JSON-SAFETY INVARIANT".
 */
export const DEFAULT_CONFIG: CryptoBattleConfig = {
  prime: HAND_PRIME.toString(),
  threshold: 3,
  shareCount: 5,
  matchDurationMs: 90 * 60_000,
  phaseBoundaries: {
    buildToPressureMs: 30 * 60_000,
    pressureToEndgameMs: 60 * 60_000,
  },
  // [Issue #659] Orders arrive every 5 minutes and expire in 5, so a team is
  // always working on the batch in front of it — there is no stockpiling and no
  // taking ahead. That single rule is what keeps LEAK from paying: with a
  // backlog to draw on, leaking an Order frees five minutes that convert into
  // another PROVE, so leaking always beat proving no matter how the points were
  // set. It also gives a fast team's spare capacity nowhere to go but HUNT,
  // which is what finally makes hunting worth its five minutes.
  contractIntervalMs: 5 * 60_000,
  contractsPerIssue: 6,
  // [Issue #695] The batch after the ONE-Order opening comes in a minute, not
  // five: clearing that single Order and then watching an empty belt for a full
  // interval is what the live run reported as 「次のオーダーがこない」.
  onboardingFollowUpMs: 60_000,
  // [Issue #696] At or below `threshold` (3) -- see the field's doc comment.
  maxHuntAttemptsPerTarget: 3,
  contractTtlMs: 5 * 60_000,
  rushContractTtlMs: 2.5 * 60_000,
  rotateCooldownMs: 3 * 60_000,
  scores: {
    // [Issue #659] 失効 -15 < LEAK して狩られる -2 < LEAK 無事 +10 < PROVE +30
    contract: 30,
    duelWin: 30,
    duelDraw: 10,
    contractLeak: 10,
    expiredOrder: -15,
    rushContract: 45,
    huntBonus: 25,
    huntPenalty: 12,
    // [Issue #696] A wrong HUNT costs the attacker. Below `huntBonus` (25) so a
    // team that interpolates correctly still profits after an earlier miss, and
    // above zero so scanning the (now small) field is never free.
    wrongHunt: 8,
    // [Issue #701, #709] What a wrong grid costs. Below `huntBonus` so a team
    // that slips once and then relabels correctly still comes out ahead; above
    // zero so the judge is not a free sudoku checker.
    wrongProve: 6,
    // [Issue #659 §9] Escalating, and bounded by the ordering above: buying all
    // three costs 14, so an Order computed after every hint still pays 16 —
    // above LEAK's 10. Hints that could drag a solved Order below what leaking
    // it would have paid would quietly restore "LEAK is always right", which is
    // the failure the whole scoring model exists to remove.
    hintCosts: [2, 4, 8],
  },
};

function mergeConfig(config: Partial<CryptoBattleConfig> | undefined): CryptoBattleConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    phaseBoundaries: { ...DEFAULT_CONFIG.phaseBoundaries, ...config?.phaseBoundaries },
    scores: { ...DEFAULT_CONFIG.scores, ...config?.scores },
  };
}

/**
 * Boundary conversion (Issue #486 PR3 review fix): `fixtures.ts`'s
 * derivations are pure `bigint` functions (see that file's header), but
 * `CryptoBattleConfig.prime` is a stringified bigint for JSON-safety. This is
 * the one place that bridges the two, so every `fixtures.ts` call site below
 * converts through it rather than re-deriving `BigInt(config.prime)` inline.
 */
function fieldConfigOf(config: CryptoBattleConfig): FieldConfig {
  return { prime: BigInt(config.prime), threshold: config.threshold, shareCount: config.shareCount };
}

/**
 * [Issue #652] The prefix marking a seed the platform did NOT issue.
 *
 * Kept visible in `state.seed` on purpose. A match running on this string is
 * one whose hidden material every participant can recompute from the public
 * `eventId`, so it must be greppable in a dump rather than silently
 * indistinguishable from a real match.
 */
export const LOCAL_PLAY_SEED_PREFIX = "local-play-not-secret:";

/**
 * [Issue #652] The seed every hidden value in the match derives from.
 *
 * Prefers the platform's per-match secret. Falls back to a clearly-marked
 * value built from `eventId` ONLY when no secret was issued — local play and
 * unit tests, where there is no dispatcher to issue one and no opponent to
 * hide anything from.
 *
 * The fallback is not a weaker secret; it is not a secret at all, which is why
 * it announces itself. A real event always runs through the coordination
 * dispatcher, so a real event always has `ctx.matchSecret`.
 */
export function resolveMatchSeed(ctx: CoordinationContext): string {
  return ctx.matchSecret ?? `${LOCAL_PLAY_SEED_PREFIX}${ctx.eventId}`;
}

/** Current deployed pacing; persisted legacy matches retain their own configuration. */
export const STREAMING_ORDER_CONFIG: Partial<CryptoBattleConfig> = {
  proofProtocol: "schnorr-v1",
  ecOrders:true,
  ioOrders:true,
  starkOrders:true,
  anamorphicOrders:true,
  snarkOrders:true,
  evolutionOrders:true,
  ...pacingConfig(MATCH_PACING),
  contractsPerIssue: 1,
  maxOpenOrdersPerTeam: 3,
};

export function initialState(
  ctx: CoordinationContext,
  config?: Partial<CryptoBattleConfig>,
): CryptoBattleState {
  const mergedConfig = mergeConfig(config);
  const fieldConfig = fieldConfigOf(mergedConfig);
  const teams: Record<string, TeamState> = {};
  const publicPuzzles: Record<string, SudokuGrid> = {};
  // Derive from the match seed, never from `ctx.eventId` — everything below
  // (and every later ROTATE, Order belt, FHE and MPC derivation, all of which
  // already read `state.seed`) hangs off this one value.
  const seed = resolveMatchSeed(ctx);
  const scoreSteal = initialSteal(ctx);
  for (const teamId of ctx.teamIds) {
    const { secret, shares } = deriveTeamGeneration(seed, teamId, 1, fieldConfig);
    teams[teamId] = {
      teamId,
      // [Issue #3172] Captured at materialisation: the only hook that receives
      // `ctx` is this one, so a rename after the match starts keeps the old
      // name. Absent when the platform could not resolve one, and the
      // projection falls back to the id.
      ...(ctx.teamNames?.[teamId] ? { teamName: ctx.teamNames[teamId] } : {}),
      score: 0,
      generation: 1,
      secret: secret.toString(),
      shares: shares.map((s): StoredShare => ({ index: s.index, value: s.value.toString() })),
      lastRotateAtMs: undefined,
      issuedOrderCount: 0,
      completedContractIds: [],
      huntedGenerations: [],
      cipherHuntedGenerations: {},
      sudokuHuntedGenerations: [],
    };
    publicPuzzles[teamId] = deriveSudokuPuzzle(seed, teamId, 1);
  }
  return withMatchDuration({
    ...(scoreSteal ? { scoreSteal } : {}),
    config: mergedConfig,
    seed,
    // [Issue #677] A deployed match waits to be started -- see `Phase`.
    phase: "waiting",
    readyTeamIds: [],
    endgameBooster: { status: "pending" },
    endgameLightning: { status: "pending" },
    nowMs: undefined,
    startedAtMs: undefined,
    nextContractAtMs: undefined,
    contracts: [],
    publicLedger: [],
    teams,
    publicPuzzles,
    successfulHunts: [],
    huntAttempts: {},
    huntLog: [],
  }, ctx.matchDurationMs);
}

function computePhase(elapsedMs: number, config: CryptoBattleConfig): Phase {
  if (elapsedMs >= config.matchDurationMs) return "ended";
  if (elapsedMs >= config.phaseBoundaries.pressureToEndgameMs) return "endgame";
  if (elapsedMs >= config.phaseBoundaries.buildToPressureMs) return "pressure";
  return "build";
}

/**
 * Advance the match clock to `eventNowMs`: recompute phase, expire stale open
 * contracts, and issue every contract batch due at or before `eventNowMs`.
 * `eventNowMs` must be non-decreasing across calls for the same state lineage
 * (the reducer trusts its caller for monotonicity, same as any event-sourced
 * reducer -- it does not read a clock itself, see this file's purity contract
 * above).
 */
/**
 * [Issue #645] The public payload one Order carries.
 *
 * FHE and MPC payloads are derived from `(seed, orderId)` rather than stored on
 * the plan, and the confidential half is not derived here at all: the judge
 * re-derives the plaintexts, the key and the masks when it needs them, and
 * `projectForTeam` derives the owning team's private inputs. So the only thing
 * that ever reaches `CryptoBattleState` is material that is safe to publish,
 * and there is no new secret field anyone could forget to redact.
 */
function buildOrderTask(
  plan: ContractPlan,
  seed: string,
  contractId: string,
  prime: bigint,
  teamId: string,
  generation: number,
): OrderTask {
  switch (plan.taskKind) {
    case "ssm-decrypt": throw new Error("Score item is issued through its deployment-bound path");
    case "anamorphic-rejection": {
      let counter=0,index=0,bytes=Buffer.alloc(0);
      const task = anamorphicTask(()=>{
        if(index===bytes.length){
          bytes=createHmac("sha256",seed).update(JSON.stringify(["anamorphic-v1",contractId,counter++])).digest();index=0;
        }
        return bytes[index++]!;
      });
      const exercises = ["encrypt", "decrypt", "probability"] as const;
      return {...task, exercise: exercises[createHmac("sha256",seed).update(`anamorphic-exercise:${contractId}`).digest()[0]! % 3]!};
    }
    case "stark-trace": return starkTask([...createHmac("sha256",seed).update(`stark:${contractId}`).digest()]);
    case "io-equivalence": return ioTask([...createHmac("sha256",seed).update(`io:${contractId}`).digest()]);
    case "rsa-decrypt":
    case "enigma-encrypt":
    case "ecdsa-sign": return evolutionTask(plan.taskKind, [...createHmac("sha256",seed).update(`evolution:${contractId}`).digest()]);
    case "snark-constraints": return constraintTask([...createHmac("sha256",seed).update(`snark:${contractId}`).digest()]);
    case "ec-add": {
      const bytes=createHmac("sha256",seed).update(`ec:${contractId}`).digest();
      return {kind:"ec-add",left:CURVE_POINTS[bytes[0]!%CURVE_POINTS.length]!,right:CURVE_POINTS[bytes[1]!%CURVE_POINTS.length]!};
    }
    case "rotor-encrypt": return { kind: "rotor-encrypt", generation, plaintext: deriveRotorPlaintext(seed, contractId) };
    case "rsa-encrypt": {
      const { n, e } = deriveRsaKey(seed, teamId, generation);
      return { kind: "rsa-encrypt", n, e, plaintext: deriveRsaPlaintext(seed, contractId) };
    }
    case "reveal-share":
      return { kind: "reveal-share", shareIndices: plan.requestedShareIndices };
    case "homomorphic-sum":
      return {
        kind: "homomorphic-sum",
        inputs: deriveFheOrderInputs(seed, contractId, prime).map((c) => ({
          r: c.r.toString(),
          y: c.y.toString(),
        })),
      };
    case "masked-total":
      return { kind: "masked-total", partyCount: MPC_PARTY_COUNT };
    case "caesar-shift": {
      // [Issue #659 §5] The method, the alphabet and the break threshold are
      // all stated ON the Order. That is Kerckhoffs's principle as a game rule:
      // every team knows how the cipher works, and the only thing that decides
      // who survives is who kept their key.
      const rung: CipherRung = plan.rung ?? "caesar";
      return { kind: "caesar-shift", rung, plaintext: derivePlaintext(seed, contractId, rung), ...(plan.keyPosition === undefined ? {} : { keyPosition: plan.keyPosition }) };
    }
    case "zk-sudoku":
      // [Issue #709] No payload: the puzzle is already public and the solution
      // is in the team's vault. Which group the judge opens is derived from the
      // Order id at judgement time, not stated here.
      return { kind: "zk-sudoku" };
    default: {
      const exhaustive: never = plan.taskKind;
      throw new Error(`buildOrderTask: unknown task kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * A contract as it may actually come back from storage, rather than as the
 * current version writes it.
 *
 * A match is long-lived and its state is persisted between calls, so a deploy
 * mid-match hands the reducer rows written by an OLDER version of this plugin.
 * Every field this file later treats as required is optional here, which is
 * what makes {@link migrateContract} total instead of a pile of non-null
 * assertions at each use site.
 */
type PersistedContract = Omit<
  Contract,
  "task" | "privacyConstraint" | "allowedMethods" | "leakPoints"
> & {
  /** [Issue #659] Absent on Orders written before LEAK and PROVE paid differently. */
  readonly leakPoints?: number;
  readonly task?: OrderTask;
  /** Pre-#645: an Order asked for share indices and nothing else. */
  readonly requestedShareIndices?: readonly number[];
  /** Pre-#650: an Order carried no privacy rule and no method list. */
  readonly privacyConstraint?: PrivacyConstraint;
  readonly allowedMethods?: readonly SubmissionMethod[];
};

/**
 * Whether a persisted Order is missing ANY field {@link migrateContract} fills.
 *
 * [Issue #659] This has to name every backfilled field, not just the ones the
 * first migration added. It listed `task` / `allowedMethods` only, so an Order
 * written after #645 (which has both) but before #659 (which added
 * `leakPoints`) was judged not to need migrating — and the backfill written
 * specifically to stop `score + undefined` from producing NaN never ran on the
 * rows that needed it.
 *
 * Found on the live development environment, not in a test: the deployed match
 * projected `leakPoints: undefined` on all 45 of its Orders. The migration
 * tests missed it because they build a legacy row by deleting `task` and
 * `allowedMethods` too, which trips the predicate for the wrong reason.
 */
function needsMigration(contract: Contract): boolean {
  const persisted: PersistedContract = contract;
  return (
    persisted.task === undefined ||
    persisted.allowedMethods === undefined ||
    persisted.leakPoints === undefined
  );
}

/**
 * [Issue #645] Bring one persisted Order up to the current shape.
 *
 * Any version that adds a REQUIRED contract field has to say what an older row
 * means, or the first read of that field throws and takes the whole match with
 * it. Two fields need that answer here:
 *
 *  - `task` (this change). Before it, every Order asked for share indices and
 *    nothing else -- so a legacy row IS a `reveal-share` Order and converts
 *    exactly. Without this, `projectTask` reads `.kind` off `undefined` and
 *    `projectForTeam` throws for EVERY team in the match: `myContracts`
 *    includes completed and expired rows, so a single pre-upgrade Order is
 *    enough, and no later `tick` ever repairs those rows.
 *  - `privacyConstraint` / `allowedMethods` (#650). Older, and the same class
 *    of failure one function earlier -- `validateOrderSubmission` reads
 *    `allowedMethods.includes(...)`. #650 shipped without a fallback; covering
 *    it is two lines inside the function that has to exist anyway, and leaving
 *    a known crash of exactly this shape out of the migration written to
 *    prevent it would be hard to defend.
 *
 * Lossless where it matters: id, points, deadline, status and resolution are
 * carried through untouched, so no score or history moves.
 */
function migrateContract(contract: Contract): Contract {
  if (!needsMigration(contract)) return contract;
  const persisted: PersistedContract = contract;

  const privacyConstraint = persisted.privacyConstraint ?? "none";
  const task: OrderTask = persisted.task ?? {
    kind: "reveal-share",
    shareIndices: persisted.requestedShareIndices ?? [],
  };
  return {
    ...contract,
    task,
    privacyConstraint,
    allowedMethods: persisted.allowedMethods ?? allowedMethodsFor(task.kind, privacyConstraint),
    // [Issue #659] Orders written before LEAK and PROVE paid differently carry
    // no `leakPoints`. Without this backfill, leaking such an Order adds
    // `undefined` to the score and the team's total becomes NaN — a silent,
    // unrecoverable corruption of a live match rather than a visible failure.
    leakPoints: persisted.leakPoints ?? DEFAULT_CONFIG.scores.contractLeak,
  };
}

/**
 * [Issue #659] Bring a persisted CONFIG up to the current shape.
 *
 * `mergeConfig` runs in `initialState` and nowhere else, so a config only ever
 * gets its defaults filled in at the moment a match starts. Every later read
 * comes off the persisted row -- and a coordination row outlives the code that
 * wrote it (that is the whole reason #3126 / #3135 exist), so a match started
 * before this version is read back by a reducer that expects fields its config
 * has never heard of. Both new fields fail silently rather than loudly:
 *
 *  - `contractsPerIssue` undefined makes the batch loop's bound `undefined`, so
 *    it runs zero times: the match stops issuing Orders altogether and simply
 *    winds down, with nothing in the logs to say why.
 *  - `scores.expiredOrder` undefined turns the first expiry into
 *    `score + undefined`, and the team's total is NaN for the rest of the
 *    match -- the same corruption `migrateContract`'s `leakPoints` backfill
 *    exists to prevent, one level up.
 *
 * Re-merging is the whole fix: `mergeConfig` is already the function that says
 * what a missing field means, and it leaves every value the row does carry
 * exactly as it found it.
 */
function needsConfigMigration(config: CryptoBattleConfig): boolean {
  return (
    config.contractsPerIssue === undefined ||
    config.scores?.expiredOrder === undefined ||
    config.scores?.contractLeak === undefined ||
    // [Issue #659 §9] Same class as the two above, one slice later. A row
    // written before hints existed has no price list, and `hintCostAt` reads
    // `.length`/`[level]` off it -- so without this backfill the first HINT in
    // an upgraded match throws inside `validateOp` instead of being refused.
    config.scores?.hintCosts === undefined ||
    // [Issue #695] Undefined makes `nextContractAtMs += undefined` produce NaN
    // on the opening batch, and `nextContractAtMs <= eventNowMs` is false for
    // NaN forever after -- the belt would stop issuing for the rest of the
    // match, which is the same silent wind-down `contractsPerIssue` describes.
    config.onboardingFollowUpMs === undefined ||
    // [Issue #696] Undefined makes `spent >= undefined` false for every value,
    // so the budget never binds and a wrong HUNT is free again -- which is
    // exactly the hole the cap exists to close. Fail towards the cap, not past
    // it.
    config.maxHuntAttemptsPerTarget === undefined ||
    config.scores?.wrongHunt === undefined ||
    // [Issue #709] `projectForTeam` exposes `wrongProveCost` unconditionally,
    // and the Portal's projection guard requires it to be a number -- so a row
    // written before the sudoku PROVE existed would project `undefined` and
    // the whole Battle surface would read as unavailable for that match.
    config.scores?.duelWin === undefined ||
    config.scores?.duelDraw === undefined ||
    config.scores?.wrongProve === undefined
  );
}

/**
 * Every entry point below reads `state.contracts` and `state.config`, so every
 * entry point migrates both first. `applyOp` and `tick` return the migrated
 * state, so the upgrade also persists on the next write rather than being
 * redone forever.
 */
/**
 * [Issue #659] Bring persisted TEAMS up to the current shape.
 *
 * `cipherHuntedGenerations` arrived with the cipher ladder, so a team row
 * written before it has no such field. `applyHuntCipher` reads
 * `target.cipherHuntedGenerations[rung]`, which on `undefined` throws and takes
 * the op — and with it the match — down. Third new required field in three
 * slices; each one needs its answer for an older row written in the same commit
 * that adds it.
 *
 * An empty record is the honest default: a team whose row predates the ladder
 * has had no rung broken, because there were no rungs.
 */
function migrateTeams(
  teams: Readonly<Record<string, TeamState>>,
  contracts: readonly Contract[],
): Readonly<Record<string, TeamState>> {
  const next: Record<string, TeamState> = {};
  for (const [teamId, team] of Object.entries(teams)) {
    next[teamId] = {
      ...team,
      completedContractIds: compactCompletedContractIds(teamId, team.completedContractIds),
      cipherHuntedGenerations: team.cipherHuntedGenerations ?? {},
      // [Issue #709] Same class: a row written before the sudoku HUNT existed
      // has had no solution recovered, because there was none to recover.
      sudokuHuntedGenerations: team.sudokuHuntedGenerations ?? [],
      // [Issue #659] An older row counted issued Orders by the length of the
      // Order list, so the list IS the count for that row -- but read the
      // highest sequence rather than the length, because a delayed tick could
      // already have skipped a slot and left the two disagreeing. Getting this
      // wrong would re-issue an id the match has already used.
      issuedOrderCount: team.issuedOrderCount ?? highestSequenceFor(contracts, teamId) + 1,
    };
  }
  return next;
}

/** The largest sequence index this team's Orders carry, or -1 if it has none. */
function highestSequenceFor(contracts: readonly Contract[], teamId: string): number {
  let highest = -1;
  for (const c of contracts) {
    if (c.teamId !== teamId) continue;
    const at = c.id.lastIndexOf("-c");
    const sequence = at < 0 ? Number.NaN : Number(c.id.slice(at + 2));
    if (Number.isInteger(sequence) && sequence > highest) highest = sequence;
  }
  return highest;
}

function needsTeamMigration(teams: Readonly<Record<string, TeamState>>): boolean {
  return Object.values(teams).some(
    (team) =>
      compactCompletedContractIds(team.teamId, team.completedContractIds) !== team.completedContractIds ||
      !team.cipherHuntedGenerations ||
      team.issuedOrderCount === undefined ||
      team.sudokuHuntedGenerations === undefined,
  );
}

/**
 * [Issue #709] Every team's current puzzle, for a row that predates the sudoku
 * PROVE. Derived from what the row already holds (seed, generation), so the
 * backfill is exactly what `initialState` / `applyRotate` would have written.
 * A row that has the field keeps it untouched.
 */
function migratePublicPuzzles(state: CryptoBattleState): Readonly<Record<string, SudokuGrid>> {
  if (state.publicPuzzles !== undefined) return state.publicPuzzles;
  const puzzles: Record<string, SudokuGrid> = {};
  for (const team of Object.values(state.teams)) {
    puzzles[team.teamId] = deriveSudokuPuzzle(state.seed, team.teamId, team.generation);
  }
  return puzzles;
}

/**
 * [Issue #709] The schema version this package reads and writes. Declared on
 * the plugin (`coordination/crypto-battle.ts`), compared by the platform
 * against the version stamped on a persisted row.
 *
 *   1  `publicLedger` as full `PublicArtifact[]`
 *   2  `publicLedger` as compact `StoredArtifact[]` (TenkaCloud#3150)
 *   3  the sudoku PROVE: `publicPuzzles` replaces `publicCommitments`, the
 *      ledger gains the `sudoku-reveal` kind, teams gain
 *      `sudokuHuntedGenerations` / `lastProve`, Orders lose
 *      `proveCommitment` / `proveChallenge`
 *   4  roster-indexed HUNT budget keys and lossless numeric ledger Order IDs
 *   5  `lastHunt.points` records the actual score delta of new HUNT results
 *   6  endgame booster distribution, fixed once at the phase boundary
 *   7  Vigenère rung and public key-position offsets (old Caesar rows keep scalar keys)
 *   8  Vigenère wrong-answer reward forfeiture and own lastCipher adjudication
 *   9  private lightning distribution, targeted card, and accepted-answer history
 *  10  RSA Orders/pairs, exact-time factor HUNT logs and compact completed IDs
 *  11  Rotor Orders/pairs; ledger tuples; lossless audit/counter/guard/verdict roster codecs
 *  12  generation-scoped disclosure retirement cost
 *
 * The bump matters for ROLLBACK, not only for upgrade: a v2 worker's ledger
 * decoder throws on a kind it does not know, so a v3 row it was told was v2
 * would take the match down the first time it decoded a `sudoku-reveal`.
 * With the version declared, the platform refuses the row instead.
 */
// v22 adds a persisted queue cap and independent anamorphic worksheets.
// Older rows keep their existing tasks and unlimited queue settings.
// v24 adds the platform-reported match length and its rejection code. A v23
// row has neither and keeps the length it was created with until a report.
export const STATE_SCHEMA_VERSION = 24;

/**
 * [Issue #709] The plugin's `migrateState`: lifts a row written under an
 * earlier schema version to `STATE_SCHEMA_VERSION`. Pure in `(state,
 * fromVersion)` -- no `ctx`, so no secret material can reach a migration --
 * and it THROWS on anything it does not recognise, which the platform treats
 * as "leave the row alone" (no `initialState`, no write, no reset).
 *
 * v1 -> v2 is `ledger-codec.ts`'s `migrateStateV1`, unchanged. v2 -> v3 is
 * the same repair `withMigratedContracts` already performs on every read --
 * puzzles derived from the seed, hunted-generation lists backfilled, the
 * wrong-PROVE price merged in -- plus dropping the fields v3 no longer has.
 * A legacy `proof` ledger entry is kept: it still decodes and renders.
 * v4 -> v5 preserves old `lastHunt` records without `points`: the actual
 * historical delta cannot be recovered from a current score or price, so it
 * stays unknown. Only a new HUNT writes the field. v4's numeric roster budget
 * keys are validated and retained, not compacted again as logical team IDs.
 * v5 -> v6 records pending distribution before the boundary, or an explicit
 * unavailable result afterward when the old row has no historical ranking.
 * v6 -> v7 retains existing scalar Caesar Orders, ledgers and reservations.
 * Only newly issued Vigenère Orders gain public key-position offsets.
 * v7 -> v8 preserves existing Vigenère rows and reservations. Only a newly
 * adjudicated incorrect CIPHER writes cipherFailed/lastCipher; absent means no
 * previously charged failure. Existing true flags survive every migration.
 * v8 -> v9 adds pending/unavailable lightning distribution, preserving all
 * Vigenère and compact reservations. Legacy Orders have unknown accepted-answer history
 * and cannot be targeted; the next issued Orders record answerAttempted=false.
 * v9 -> v10 preserves existing Orders, cipherFailed and lightning cards exactly.
 * RSA is issued only for future scheduled standard endgame cipher slots. Completed
 * exact Order IDs reuse the ledger codec. Legacy hunt-log objects remain unchanged;
 * no timestamps are invented for pre-patch RSA reservations without a log.
 * v10 -> v11 preserves public Ledger values/order in roster-indexed tuples,
 * groups exact-time HUNT logs and separate attempt counters by target/generation,
 * and packs untimed successful-HUNT guards without inventing timestamps. If
 * grouping would change any same-time legacy replay order, the entire old log
 * stays in its original representation. Pending RPS reservations keep their
 * original generation; old lastHunt objects remain readable beside new tuples.
 * Rotor is issued only in future scheduled normal pressure cipher slots.
 * v11 -> v12 preserves scores, Orders and history. Existing generations have
 * no disclosure retirement fee; only future mandatory LEAKs record that fee.
 */
export function migrateState(state: unknown, fromVersion: number): CryptoBattleState {
  if (fromVersion !== 1 && fromVersion !== 2 && fromVersion !== 3 && fromVersion !== 4 && fromVersion !== 5 && fromVersion !== 6 && fromVersion !== 7 && fromVersion !== 8 && fromVersion !== 9 && fromVersion !== 10 && fromVersion !== 11 && fromVersion !== 12 && fromVersion !== 13 && fromVersion !== 14 && fromVersion !== 15 && fromVersion !== 16 && fromVersion !== 17 && fromVersion !== 18 && fromVersion !== 19 && fromVersion !== 20 && fromVersion !== 21 && fromVersion !== 22 && fromVersion !== 23) {
    throw new Error(
      `reducer: migrateState cannot migrate from schema version ${fromVersion} (only v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16, v17, v18, v19, v20, v21, v22 and v23 -> v${STATE_SCHEMA_VERSION} are defined)`,
    );
  }
  const v2 = fromVersion === 1 ? migrateStateV1(state, 1) : state;
  if (typeof v2 !== "object" || v2 === null) {
    throw new Error("reducer: migrateState received a non-object state");
  }
  const row = v2 as Partial<CryptoBattleState> & { readonly publicCommitments?: unknown };
  if (typeof row.seed !== "string" || !Array.isArray(row.contracts) || typeof row.teams !== "object" || row.teams === null) {
    throw new Error("reducer: migrateState: v2 state is missing seed, contracts or teams");
  }
  const { publicCommitments: _legacyCommitments, ...rest } = row;
  // v3 has no nonce-reuse HUNT. A v2 row whose ledger still holds an UNSPENT
  // one -- two Schnorr transcripts sharing a commitment on a team's current
  // generation, and some other team that has not yet hunted that generation
  // -- carries an attack the visible record had already earned. Dropping it
  // silently would change the match's scoring mid-run, and there is no v3
  // move it maps onto (a sudoku HUNT needs reveals the row does not have).
  // So the migration refuses, which the platform treats as "leave the row
  // alone": the match finishes on the plugin that made it, or the operator
  // resets it. See OPERATOR.md, "Upgrading across a schema version".
  // An ENDED match has nothing left to spend: `validateOp` refuses every op
  // after the end, so the exposure is history and the row migrates for its
  // scores, ledger and replay.
  const exposure = fromVersion >= 3 || rest.phase === "ended" ? undefined : unspentNonceExposure(rest as CryptoBattleState);
  if (exposure) {
    throw new Error(
      `reducer: migrateState: team "${exposure.teamId}" generation ${exposure.generation} carries an unspent nonce-reuse HUNT from the retired Schnorr PROVE; finish or reset this match before upgrading`,
    );
  }
  const lifted = withMigratedContracts(rest as CryptoBattleState);
  return settleLightning({
    ...lifted,
    ...compactRecordedHunts(lifted),
    publicLedger: lifted.publicLedger.map(a => encodeArtifact(decodeArtifact(a, lifted.teams), lifted.teams)),
    huntAttempts: packHuntAttempts({ ...lifted, huntAttempts: fromVersion >= 4 ? validateStoredHuntAttempts(lifted) : compactHuntAttempts(lifted) }),
    contracts: lifted.contracts.map((contract) => {
      const { proveCommitment: _c, proveChallenge: _e, ...kept } = contract as Contract & {
        readonly proveCommitment?: unknown;
        readonly proveChallenge?: unknown;
      };
      if (kept.schnorr) {
        // v13/v14 fixed the challenge without recording answerAttempted, and
        // left one-shot PROVE-only misses open. Preserve scores and history;
        // only normalize future eligibility and the already-consumed attempt.
        const missed = kept.schnorr.used === true && (kept.schnorr.outcome === "miss"
          || (kept.schnorr.outcome === undefined && kept.status === "open"));
        const terminal = missed && kept.status === "open"
          && kept.allowedMethods.length === 1 && kept.allowedMethods[0] === "prove";
        return {...kept, answerAttempted:true,
          ...(missed ? {schnorr:{...kept.schnorr,outcome:"miss" as const}} : {}),
          ...(terminal ? {status:"completed" as const,resolution:"prove" as const} : {})} as Contract;
      }
      return kept as Contract;
    }),
  });
}

/**
 * [Issue #709] A team whose CURRENT generation has two legacy `proof` rows
 * sharing a commitment, and some other team that has not yet spent a HUNT on
 * that generation. Under v2 the nonce HUNT and the Shamir HUNT shared one
 * `successfulHunts` key, so a key from any attacker on (team, generation)
 * means that attacker has already collected.
 */
function unspentNonceExposure(
  state: CryptoBattleState,
): { readonly teamId: string; readonly generation: number } | undefined {
  const teamIds = Object.keys(state.teams);
  for (const team of Object.values(state.teams)) {
    const commitments = new Set<string>();
    let reused = false;
    for (const stored of state.publicLedger) {
    const artifact = artifactFields(stored);
      if (artifact.k !== "proof" || storedTeamId(artifact, state.teams) !== team.teamId || artifact.g !== team.generation) continue;
      if (commitments.has(artifact.o)) reused = true;
      commitments.add(artifact.o);
    }
    if (!reused) continue;
    const attackerLeft = teamIds.some(
      (attacker) => attacker !== team.teamId && !hasSuccessfulHunt(state, huntKey(attacker, team.teamId, team.generation)),
    );
    if (attackerLeft) return { teamId: team.teamId, generation: team.generation };
  }
  return undefined;
}

function withMigratedContracts(persistedState: CryptoBattleState): CryptoBattleState {
  const endgameBooster = storedBooster(persistedState);
  const endgameLightning = storedLightning(persistedState);
  const state = endgameBooster === persistedState.endgameBooster && endgameLightning === persistedState.endgameLightning ? persistedState
    : { ...persistedState, endgameBooster, endgameLightning };
  const config = needsConfigMigration(state.config) ? mergeConfig(state.config) : state.config;
  const teams = needsTeamMigration(state.teams)
    ? migrateTeams(state.teams, state.contracts)
    : state.teams;
  // [Issue #696] A row written before the budget existed starts with a full
  // one. `applyHunt` writes through this map and `validateOp` reads it, so
  // leaving it undefined would make the spread in `applyHunt` throw.
  const huntAttempts = state.huntAttempts ?? {};
  const publicPuzzles = migratePublicPuzzles(state);
  const unchanged =
    config === state.config &&
    teams === state.teams &&
    huntAttempts === state.huntAttempts &&
    publicPuzzles === state.publicPuzzles;
  if (!state.contracts.some(needsMigration)) {
    return unchanged ? state : { ...state, config, teams, huntAttempts, publicPuzzles };
  }
  return {
    ...state,
    config,
    teams,
    huntAttempts,
    publicPuzzles,
    contracts: state.contracts.map(migrateContract),
  };
}

/**
 * [Issue #926] `timing` is the platform's report for this tick. It sets the end
 * before `advance` replays the clock to `eventNowMs` -- see `match-length.ts`.
 * A stale clock carries a stale report, so both are ignored.
 */
export function tick(persistedState: CryptoBattleState, eventNowMs: number, timing?: CoordinationTiming): CryptoBattleState {
  if (eventNowMs < (persistedState.nowMs ?? eventNowMs)) return advance(persistedState, eventNowMs);
  return advance(withMatchDuration(withMigratedContracts(persistedState), timing?.matchDurationMs), eventNowMs);
}

function advance(persistedState: CryptoBattleState, eventNowMs: number): CryptoBattleState {
  let state = withMigratedContracts(persistedState);
  if (state.nowMs !== undefined && eventNowMs < state.nowMs) return state;
  if (state.startedAtMs === undefined) return tickAtTime(state, eventNowMs);

  // Replay arrivals and deadlines in time order so capacity, score floors,
  // duel settlements and endgame rankings do not depend on polling (#897).
  while (true) {
    const now = state.nowMs ?? state.startedAtMs!;
    const matchEnd = state.startedAtMs! + state.config.matchDurationMs;
    let at = eventNowMs;
    const arrival = state.nextContractAtMs ?? state.startedAtMs!;
    if (arrival >= now && arrival < matchEnd) at = Math.min(at, arrival);
    for (const order of state.contracts) {
      if (order.status === "open" && order.expiresAtMs > now) at = Math.min(at, order.expiresAtMs);
    }
    const boundary = boosterStartAt(state);
    if ((state.endgameBooster?.status === "pending" || state.endgameLightning?.status === "pending") &&
        boundary !== undefined && boundary >= now && boundary < matchEnd) at = Math.min(at, boundary);
    state = tickEvent(state, at);
    if (at === eventNowMs) return state;
  }
}

function tickEvent(state: CryptoBattleState, eventNowMs: number): CryptoBattleState {
  const advanced = tickAtTime(state, eventNowMs);
  const boundary = boosterStartAt(state);
  // [Issue #926] An end moved before the endgame means the endgame never came.
  if (boundary !== undefined && eventNowMs >= boundary && boundary < state.startedAtMs! + state.config.matchDurationMs) {
    return settleLightning({ ...advanced,
      endgameBooster: state.endgameBooster?.status === "pending" ? awardBooster(advanced) : state.endgameBooster,
      endgameLightning: state.endgameLightning?.status === "pending" ? awardLightning(advanced) : state.endgameLightning,
    });
  }
  return settleLightning(advanced);
}

function tickAtTime(persistedState: CryptoBattleState, eventNowMs: number): CryptoBattleState {
  let state = expireRps(withMigratedContracts(persistedState), eventNowMs);
  // [Issue #677] An unstarted match is not a match in progress at minute zero.
  //
  // The belt used to begin the moment the platform first ticked, which is one
  // minute after the event opens -- not when anyone sits down. Six Orders then
  // arrived every five minutes and lapsed at -15 each, so a match nobody had
  // opened yet drove every team to the zero floor within one batch and held
  // them there, and the ninety-minute clock ran out whether or not a single
  // move had been made. Deploying early for a later start, or coming back to a
  // match after a break, both landed on a dead board.
  //
  // Advancing `nowMs` and nothing else keeps the clock readable (the portal
  // still polls) while leaving the match exactly as it was deployed.
  if (state.startedAtMs === undefined) {
    return { ...state, phase: "waiting", nowMs: eventNowMs };
  }
  const startedAtMs = state.startedAtMs;
  const elapsedMs = eventNowMs - startedAtMs;
  const phase = computePhase(elapsedMs, state.config);
  const matchEndAtMs = startedAtMs + state.config.matchDurationMs;

  // [Issue #659] Letting an Order expire has to be the WORST outcome available —
  // worse than leaking and then being hunted over it. Otherwise ignoring Orders
  // is a safe strategy: nothing is published, so nothing can be hunted, and the
  // opponent-facing half of the game never happens. The penalty is what makes
  // "I cannot compute this in time" a real decision instead of a free pass.
  const newlyExpired: string[] = [];
  const contracts: Contract[] = state.contracts.map((c) => {
    if (c.status !== "open" || c.expiresAtMs > eventNowMs) return c;
    newlyExpired.push(c.teamId);
    return { ...c, status: "expired" as const, expiryCause: "deadline" as const };
  });

  // [Issue #659] From the team's own counter, never from the length of the
  // Order list -- see `TeamState.issuedOrderCount`. Counting the list made an
  // Order's id depend on how many Orders the row still held, so pruning one
  // rewound the sequence and minted a duplicate id.
  const issuedCountByTeam = new Map<string, number>(
    Object.entries(state.teams).map(([teamId, team]) => [teamId, team.issuedOrderCount]),
  );

  const duelCountByTeam = new Map(Object.entries(state.teams).map(([id, team]) => [id, team.issuedDuelCount ?? 0]));
  const issued: Contract[] = [];
  const openCountByTeam = new Map<string, number>();
  for (const contract of contracts) {
    if (contract.status === "open") openCountByTeam.set(contract.teamId, (openCountByTeam.get(contract.teamId) ?? 0) + 1);
  }
  const fieldConfig = fieldConfigOf(state.config);
  let nextContractAtMs = state.nextContractAtMs ?? startedAtMs;
  while (nextContractAtMs <= eventNowMs && nextContractAtMs < matchEndAtMs) {
    // [Issue #695] Read BEFORE the loop below advances the counters: this asks
    // whether the batch about to be issued is the opening one, and every team
    // in a synchronised start is at 0 here.
    const teamIds = Object.keys(state.teams);
    const isOpeningBatch =
      teamIds.length > 0 && teamIds.every((id) => (issuedCountByTeam.get(id) ?? 0) === 0);
    // Snapshot capacity before either member of a duel is issued an Order.
    // A full queue skips this scheduled slot, rather than accumulating debt.
    const hasRoom = (teamId: string) => state.config.maxOpenOrdersPerTeam === undefined ||
      (openCountByTeam.get(teamId) ?? 0) < state.config.maxOpenOrdersPerTeam;
    const batchSizes = new Map(teamIds.map(id => [id, (issuedCountByTeam.get(id) ?? 0) === 0 ? 1 : state.config.contractsPerIssue]));
    // Issue one slot across all teams before the next slot. This makes both
    // duel members see capacity after preceding ordinary Orders in this batch.
    for (let inBatch = 0; inBatch < Math.max(0,...batchSizes.values()); inBatch += 1) {
      const roomAtArrival = new Map(teamIds.map(id => [id, hasRoom(id)]));
      for (const teamId of teamIds) {
      if (inBatch >= batchSizes.get(teamId)!) continue;
      const sequenceIndex = issuedCountByTeam.get(teamId) ?? 0;
      // One of six slots, even with a smaller configured batch. A one-Order
      // batch must still progress through the other five mechanisms.
      const pairs = !isOpeningBatch && sequenceIndex % 6 === 0
        ? pairTeams(teamIds, Math.floor(sequenceIndex / 6) - 1) : [];
      const pair = pairs.find(pair => pair.includes(teamId));
      const opponentTeamId = pair?.find(id => id !== teamId);
      if (!roomAtArrival.get(teamId) || !hasRoom(teamId) ||
          (opponentTeamId !== undefined && !roomAtArrival.get(opponentTeamId))) {
        // Advance the shared curriculum slot even when not delivered. Both
        // sides must have space for a duel; never create an orphan invitation.
        issuedCountByTeam.set(teamId, sequenceIndex + 1);
        if (opponentTeamId !== undefined) duelCountByTeam.set(teamId, (duelCountByTeam.get(teamId) ?? 0) + 1);
        continue;
      }
      if (opponentTeamId !== undefined) {
        const duelId = `${nextContractAtMs}:${sequenceIndex}:${pairs.indexOf(pair!)}`;
        const expiresAtMs = Math.min(nextContractAtMs + state.config.contractTtlMs, matchEndAtMs);
        issued.push({
          id: `${teamId}-c${sequenceIndex}`, teamId, kind: "standard", points: state.config.scores.duelWin, leakPoints: 0,
          task: { kind: "rps-duel", duelId, opponentTeamId }, issuedAtMs: nextContractAtMs, expiresAtMs,
          status: "open", privacyConstraint: "none", allowedMethods: ["duel"],
        });
        openCountByTeam.set(teamId, (openCountByTeam.get(teamId) ?? 0) + 1);
        issuedCountByTeam.set(teamId, sequenceIndex + 1);
        duelCountByTeam.set(teamId, (duelCountByTeam.get(teamId) ?? 0) + 1);
        continue;
      }
      let plan = deriveContractPlan(state.seed, teamId, sequenceIndex - (duelCountByTeam.get(teamId) ?? 0), fieldConfig, { elapsedMs: nextContractAtMs - startedAtMs, buildToPressureMs: state.config.phaseBoundaries.buildToPressureMs, pressureToEndgameMs: state.config.phaseBoundaries.pressureToEndgameMs });
      if(state.config.anamorphicOrders && sequenceIndex%29===28)plan={...plan,taskKind:"anamorphic-rejection",privacyConstraint:"no-raw-disclosure",requestedShareIndices:[]};
      if(state.config.starkOrders && sequenceIndex%23===22)plan={...plan,taskKind:"stark-trace",privacyConstraint:"no-raw-disclosure",requestedShareIndices:[]};
      if(state.config.ioOrders && sequenceIndex%19===18)plan={...plan,taskKind:"io-equivalence",privacyConstraint:"no-raw-disclosure",requestedShareIndices:[]};
      if(state.config.ecOrders && sequenceIndex%13===12)plan={...plan,taskKind:"ec-add",privacyConstraint:"no-raw-disclosure",requestedShareIndices:[]};
      if(state.config.snarkOrders && sequenceIndex%17===16)plan={...plan,taskKind:"snark-constraints",privacyConstraint:"no-raw-disclosure",requestedShareIndices:[]};
      if (state.config.evolutionOrders) plan = curriculumPlan(state.seed, sequenceIndex - (duelCountByTeam.get(teamId) ?? 0), plan, fieldConfig.shareCount);
      const ttlMs = plan.kind === "rush" ? state.config.rushContractTtlMs : state.config.contractTtlMs;
      // tick replays this arrival at its scheduled time, then processes its
      // deadline. Delayed hosts therefore deliver and charge the same Orders.
      const expiresAtMs = Math.min(nextContractAtMs + ttlMs, matchEndAtMs);
      const contractId = `${teamId}-c${sequenceIndex}`;
      if (state.scoreSteal?.players[teamId]?.status === "waiting" && nextContractAtMs - startedAtMs >= 5 * 60_000 &&
          !issued.some(c => c.teamId === teamId && c.task.kind === "ssm-decrypt")) {
        issued.push({ id: contractId, teamId, kind: "standard", points: 0, leakPoints: 0,
          task: stealTask(state, teamId, contractId), issuedAtMs: nextContractAtMs,
          expiresAtMs: Math.min(nextContractAtMs + state.config.contractTtlMs, matchEndAtMs),
          status: "open", privacyConstraint: "no-raw-disclosure", allowedMethods: ["item"] });
        openCountByTeam.set(teamId, (openCountByTeam.get(teamId) ?? 0) + 1);
        issuedCountByTeam.set(teamId, sequenceIndex + 1);
        continue;
      }

      const points = plan.kind === "rush" ? state.config.scores.rushContract : state.config.scores.contract;
      issued.push({
        id: contractId,
        teamId,
        kind: plan.kind,
        points,
        // [Issue #659] LEAK pays the same on a rush Order as on a standard one:
        // rush pays more for the SPEED of computing it, and letting the system
        // answer is not faster work, it is no work.
        // [Issue #740] Except on a disclosure Order, where LEAK is the job the
        // client is paying for: it pays the Order's own rate (rush included),
        // so the only cost of answering it is the exposure, and letting it
        // lapse to stay hidden is never the better trade.
        leakPoints: plan.privacyConstraint === "must-disclose" ? points : state.config.scores.contractLeak,
        task: buildOrderTask(plan, state.seed, contractId, fieldConfig.prime, teamId, state.teams[teamId]!.generation),
        issuedAtMs: nextContractAtMs,
        expiresAtMs,
        status: "open",
        answerAttempted: false,
        // [Issue #645] The Order states its rule, and the method list follows
        // from it and the task -- never the other way round, so a method added
        // in a later phase is offered on exactly the Orders it legitimately
        // satisfies, and never on one it cannot serve at all.
        privacyConstraint: plan.privacyConstraint,
        allowedMethods: allowedMethodsFor(plan.taskKind, plan.privacyConstraint),
      });
      openCountByTeam.set(teamId, (openCountByTeam.get(teamId) ?? 0) + 1);
      issuedCountByTeam.set(teamId, sequenceIndex + 1);
      }
    }
    // [Issue #695] Only the gap AFTER the one-Order opening is shortened; every
    // batch from the second onward keeps the standard interval, so the
    // no-prefetch rule the LEAK/PROVE economy rests on is untouched for the
    // rest of the match. See `onboardingFollowUpMs` in types.ts for the one
    // bounded overlap this accepts.
    const baseInterval = isOpeningBatch ? state.config.onboardingFollowUpMs : state.config.contractIntervalMs;
    const jitter = Math.min(baseInterval - 1, Math.max(0, Math.floor(state.config.orderArrivalJitterMs ?? 0)));
    // One shared schedule for all teams; deriving from the scheduled time keeps
    // delayed ticks and replays identical. Old persisted configs have no jitter.
    const offset = jitter === 0 ? 0 : Number(deriveBigInt(state.seed, "order-arrival", nextContractAtMs - startedAtMs, BigInt(2 * jitter + 1))) - jitter;
    nextContractAtMs += baseInterval + offset;
  }

  // [Issue #659] Charge the expiry penalty to whoever let the Order lapse.
  // Floored at 0 like the HUNT penalty is: a negative running score reads as a
  // bug to a participant, and "you are at zero" already carries the message.
  if (state.scoreSteal) {
    const players = { ...state.scoreSteal.players };
    for (const order of issued) if (order.task.kind === "ssm-decrypt") players[order.teamId] = { ...players[order.teamId]!, status: "offered" };
    state = { ...state, scoreSteal: { ...state.scoreSteal, players } };
  }
  const charged = applyExpiryPenalties(state.teams, newlyExpired, state.config.scores.expiredOrder);
  // Carry the advanced sequence counters back onto the teams.
  const teams: Record<string, TeamState> = {};
  for (const [teamId, team] of Object.entries(charged)) {
    const issued = issuedCountByTeam.get(teamId) ?? team.issuedOrderCount;
    teams[teamId] = { ...team, issuedOrderCount: issued, issuedDuelCount: duelCountByTeam.get(teamId) ?? 0 };
  }

  return {
    ...state,
    phase,
    nowMs: eventNowMs,
    startedAtMs,
    nextContractAtMs,
    teams,
    contracts: pruneTerminalOrders(
      issued.length === 0 ? contracts : [...contracts, ...issued],
      eventNowMs,
      state.config,
    ),
  };
}

/**
 * [Issue #659] How long a resolved or lapsed Order stays in the persisted row.
 *
 * Not zero: a participant's own board shows what they just answered and what
 * just lapsed, and cutting that to nothing would make an Order vanish the
 * instant its deadline passed, with no chance to see that it did. Two intervals
 * covers the last round and the one before it.
 */
export const TERMINAL_ORDER_RETENTION_BATCHES = 2;

/**
 * [Issue #659] Drop terminal Orders the match no longer needs.
 *
 * The whole match is ONE row, read and rewritten on every participant action --
 * over HTTP on the Turso backend, and additionally under a 400 KB item cap on
 * DynamoDB. Measured at the platform's maximum of 99 teams (`teams.max(99)`,
 * from DynamoDB's 100-item TransactWrite limit) this row reached **4.49 MB**,
 * and Orders were 72% of it: 10,692 of them, almost all long dead. A 4.5 MB
 * read-modify-write per click is broken at any item limit.
 *
 * Dropping them is safe because a terminal Order holds no state the match still
 * reads:
 *
 *  - It has already paid. A completed Order added its points to `team.score`
 *    and a lapsed one subtracted the penalty, and the score is what is stored.
 *  - It cannot be submitted against again. `completedContractIds` is the
 *    double-submit guard and is kept independently, so a pruned Order stays
 *    refused rather than becoming answerable a second time.
 *  - Nothing reads an old one. `replay.ts` builds its debrief from the public
 *    ledger and the hunt log, never from `state.contracts`.
 *
 * The public ledger is NEVER pruned -- #659 §10 makes the fact that it does not
 * disappear the source of LEAK's weight, and ROTATE is the only thing that may
 * devalue it. This prunes the Order belt, which is a work queue, not a record.
 */
function pruneTerminalOrders(
  contracts: readonly Contract[],
  eventNowMs: number,
  config: CryptoBattleConfig,
): Contract[] {
  const keepFrom = eventNowMs - config.contractIntervalMs * TERMINAL_ORDER_RETENTION_BATCHES;
  return contracts.filter((c) => c.status === "open" || c.issuedAtMs >= keepFrom);
}

/**
 * [Issue #659] Deduct one expiry penalty per Order that lapsed this tick.
 *
 * Per Order, not per team: a team that ignored three Orders is three times as
 * far behind as one that ignored a single Order, and flattening that would make
 * "give up on the whole batch" cost the same as "miss one".
 */
function applyExpiryPenalties(
  teams: Readonly<Record<string, TeamState>>,
  expiredTeamIds: readonly string[],
  penalty: number,
): Record<string, TeamState> {
  if (expiredTeamIds.length === 0) return { ...teams };
  const next = { ...teams };
  for (const teamId of expiredTeamIds) {
    const team = next[teamId];
    if (!team) continue;
    next[teamId] = { ...team, score: Math.max(0, team.score + penalty) };
  }
  return next;
}

/**
 * JSON-encoded rather than `|`-joined: a delimiter-joined key would let a
 * team id containing `|` collide with an unrelated (attacker, target,
 * generation) triple and cause a false "already hunted" rejection.
 * `JSON.stringify` on an array of two strings + a number has no such
 * ambiguity (each string element is quoted and escaped independently).
 */
/**
 * [Issue #659 §9] How many hints are open on this Order.
 *
 * The one read path for `Contract.hintsRevealed`, which is optional (absent on
 * every Order nobody bought a hint on, and on every Order persisted before the
 * field existed). Reading it directly would put `undefined` into the level
 * arithmetic, and `undefined >= ladder.length` is `false` -- so the guard that
 * is supposed to stop a fourth hint would wave it through and then index the
 * price list with `NaN`. Centralising the default is what makes "no migration
 * needed" true rather than merely hoped for.
 */
function hintsRevealedOn(contract: Contract): number {
  return contract.hintsRevealed ?? 0;
}

/**
 * [Issue #645 Phase 2] Parse a participant-submitted ciphertext.
 *
 * Both components go through the same canonical-decimal gate as every other
 * untrusted number on the wire (see decimal.ts's
 * `parseCanonicalDecimal`), so a malformed value is a rejection here rather
 * than a throw out of `BigInt()` somewhere downstream.
 */
function parseStoredCiphertext(ciphertext: StoredCiphertext): { r: bigint; y: bigint } | undefined {
  if (typeof ciphertext !== "object" || ciphertext === null) return undefined;
  const r = parseCanonicalDecimal(ciphertext.r);
  const y = parseCanonicalDecimal(ciphertext.y);
  if (r === undefined || y === undefined) return undefined;
  return { r, y };
}

/**
 * [Issue #709] Whether the target actually reused a relabelling within one
 * generation — the misuse a sudoku HUNT exploits.
 *
 * Reads only the Public Ledger, deliberately: the attacker's evidence has to be
 * derivable from what they can see, and checking the same source the attacker
 * used is what makes that true rather than merely intended. Two reveals from
 * one team in one generation carrying the same tag were produced by one
 * relabelling π, so their cells are cells of ONE `π(S)`; lined up against the
 * team's public puzzle, they give π away, and π applied backwards gives S.
 *
 * The vault lists every relabelling a team has already spent
 * (`usedPermutations`), so a team that reads its own screen is never exposed.
 * A team that does not is — which is the lesson `ac26-w3-nonce-reuse` teaches
 * with an exponent, taught here with a permutation.
 */
function hasPermutationReuse(
  state: CryptoBattleState,
  targetTeamId: string,
  generation: number,
): boolean {
  return [...revealsByTag(state, targetTeamId, generation).values()].some((opened) => opened.length >= 2);
}

/**
 * [Issue #709] The opened groups of one team's generation, keyed by tag.
 *
 * Reads `state.publicLedger`'s STORED (compact) shape directly rather than
 * decoding the whole ledger first -- `k`/`tm`/`g`/`tg`/`gr`/`cl` are all
 * readable off `StoredArtifact` without expanding back to `PublicArtifact`
 * (see ledger-codec.ts's header on why the hot path avoids a decode it does
 * not need).
 */
function revealsByTag(
  state: CryptoBattleState,
  teamId: string,
  generation: number,
): ReadonlyMap<string, readonly OpenedGroup[]> {
  const byTag = new Map<string, OpenedGroup[]>();
  for (const stored of state.publicLedger) {
    const artifact = artifactFields(stored);
    if (artifact.k !== "sudoku-reveal") continue;
    if (storedTeamId(artifact, state.teams) !== teamId || artifact.g !== generation) continue;
    const bucket = byTag.get(artifact.tg) ?? [];
    bucket.push({ group: artifact.gr, cells: artifact.cl });
    byTag.set(artifact.tg, bucket);
  }
  return byTag;
}

/**
 * The groups this team's generation has had opened: every one under any tag,
 * and the ones under `tag` alone. Both feed `deriveRevealGroup`, in that
 * order of preference -- see its doc comment.
 */
function openedGroupsFor(
  state: CryptoBattleState,
  teamId: string,
  generation: number,
  tag: string,
): { readonly any: ReadonlySet<number>; readonly underTag: ReadonlySet<number> } {
  const any = new Set<number>();
  const underTag = new Set<number>();
  for (const [seen, reveals] of revealsByTag(state, teamId, generation)) {
    for (const reveal of reveals) {
      any.add(reveal.group);
      if (seen === tag) underTag.add(reveal.group);
    }
  }
  return { any, underTag };
}

/**
 * [Issue #709] Whether the public record has actually given a team's solution
 * away: some reused relabelling whose opened groups, held against the team's
 * public puzzle, leave exactly one solution standing.
 *
 * A repeated tag is the MISUSE; this is the EVIDENCE, and the HUNT opens only
 * on both. Without the second half a reuse whose reveals happened not to pin
 * the grid -- the puzzle allows several solutions and the opened cells do not
 * separate them -- would let an attacker in to guess, spending the limited
 * attempts on a record the statement had promised was enough. The attacker's
 * side of this is `recoverableSolutions`, the same function, run on the same
 * public inputs.
 */
function isSolutionRecoverable(
  state: CryptoBattleState,
  targetTeamId: string,
  generation: number,
): boolean {
  const puzzle = state.publicPuzzles?.[targetTeamId] ?? deriveSudokuPuzzle(state.seed, targetTeamId, generation);
  for (const opened of revealsByTag(state, targetTeamId, generation).values()) {
    if (opened.length < 2) continue;
    if (recoverableSolutions(puzzle, opened).length === 1) return true;
  }
  return false;
}

/**
 * [Issue #709] The relabellings a team has spent on its current generation,
 * oldest first, recovered from the tags on its own reveals.
 *
 * The trusted side holds the seed, so it can run the 24 candidates against a
 * tag and find the one that made it; nobody without the seed can. This is what
 * lets the vault SAY which relabellings are used up, instead of leaving a team
 * to remember, and it is also why the tag is safe to publish: the lookup that
 * turns it back into π is this function, and this function runs only here.
 */
function usedPermutationsFor(
  state: CryptoBattleState,
  teamId: string,
  generation: number,
): readonly Permutation[] {
  const used: Permutation[] = [];
  for (const stored of state.publicLedger) {
    const artifact = artifactFields(stored);
    if (artifact.k !== "sudoku-reveal") continue;
    if (storedTeamId(artifact, state.teams) !== teamId || artifact.g !== generation) continue;
    const pi = ALL_PERMUTATIONS.find(
      (candidate) => derivePermutationTag(state.seed, teamId, generation, candidate) === artifact.tg,
    );
    if (pi && !used.some((seen) => samePermutation(seen, pi))) used.push(pi);
  }
  return used;
}

/**
 * [Issue #645] The Order gate every submission method passes through.
 *
 * Whether a submission is even eligible is a property of the ORDER -- who it
 * was issued to, whether it is still open, and which methods its client
 * accepts. Only what counts as a valid artifact is a property of the METHOD.
 * Splitting them here is what makes a new method (Phase 2's FHE, Phase 3's MPC)
 * an addition rather than an edit: it writes its own trusted check and inherits
 * ownership, the deadline, and the privacy rule unchanged.
 *
 * The `allowedMethods` check is the one genuinely new rule. An Order carrying
 * `no-raw-disclosure` is #645's Level-1 "technique-specified" Order: the client
 * will not accept the underlying value being published, so LEAK is refused --
 * with the constraint named, because a participant who is told only "not
 * allowed" learns nothing they can carry to the next Order.
 */
function validateOrderSubmission(
  state: CryptoBattleState,
  teamId: string,
  contractId: string,
  method: SubmissionMethod,
): ValidateResult {
  const contract = state.contracts.find((c) => c.id === contractId);
  if (!contract) return { ok: false, error: `contract "${contractId}" not found` };
  if (contract.teamId !== teamId) {
    return { ok: false, error: `contract "${contractId}" belongs to another team` };
  }
  if (contract.status !== "open") {
    return { ok: false, error: `contract "${contractId}" is ${contract.status}, not open` };
  }
  // [Issue #645] Two different refusals, and saying which is the point.
  //
  // "This Order does not accept LEAK" is a RULE the client imposed; "LEAK
  // cannot do this job" is a FACT about the tool. methods.ts keeps them apart
  // deliberately and says so in its own comment -- and this function used to
  // collapse both into the privacy message, so submitting FHE to a share Order
  // with constraint "none" was told that FHE "does not satisfy privacy
  // constraint none". FHE satisfies `none` perfectly well. The message taught
  // the opposite of the distinction the Order model exists to teach.
  if (!methodCanPerformTask(method, contract.task.kind)) {
    return {
      ok: false,
      error: `${method.toUpperCase()} cannot perform contract "${contractId}"'s task (${contract.task.kind}); this Order is done with ${contract.allowedMethods.join(", ").toUpperCase()}`,
    };
  }
  if (!contract.allowedMethods.includes(method)) {
    return {
      ok: false,
      error: `contract "${contractId}" has privacy constraint "${contract.privacyConstraint}", which ${method.toUpperCase()} does not satisfy (allowed: ${contract.allowedMethods.join(", ").toUpperCase()})`,
    };
  }
  return { ok: true };
}

export function validateOp(
  persistedState: CryptoBattleState,
  teamId: string,
  op: CryptoBattleOp,
): ValidateResult {
  const state = withMigratedContracts(persistedState);
  const team = state.teams[teamId];
  if (!team) return { ok: false, error: `unknown team "${teamId}"` };

  // No op of any kind is legal once the match clock has run out -- without
  // this, a team could keep LEAKing / HUNTing / ROTATEing past `matchDurationMs`
  // simply because nothing else told the reducer to stop accepting ops.
  if (state.phase === "ended") {
    return { ok: false, error: "match has ended" };
  }

  // [Issue #677] START is the only move available before the match starts, and
  // it is unavailable after. Both directions matter: accepting a LEAK against
  // an empty belt would report a move that could not have happened, and
  // accepting a second START would rewind the clock mid-match.
  // [Issue #688] READY and START are both only legal before the match runs.
  // READY is the ordinary path — the match begins when every team has said so.
  // START is the escape for a team that never shows up; it is deliberately a
  // separate op so that pressing "I am ready" can never start the match for
  // someone who has not opened the portal.
  if (op.kind === "ready" || op.kind === "start") {
    return state.startedAtMs === undefined
      ? { ok: true }
      : { ok: false, error: "match already started" };
  }
  if (state.startedAtMs === undefined) {
    return { ok: false, error: "match has not started" };
  }

  switch (op.kind) {
    case "claim-steal":
    case "use-steal": return validateSteal(state, teamId, op);
    case "declare-lightning": {
      const contract = state.contracts.find(c => c.id === op.contractId && c.teamId === teamId);
      const method = contract?.allowedMethods.find(m => ["prove", "cipher", "fhe", "mpc", "ec", "io", "snark", "evolution", "stark", "anamorphic"].includes(m));
      if (!contract || !method) return { ok: false, error: "lightning requires your own calculation Order; duel outcomes do not qualify" };
      const gate = validateOrderSubmission(state, teamId, op.contractId, method);
      if (!gate.ok) return gate;
      return lightningEligible(state, contract) ? { ok: true }
        : { ok: false, error: "lightning is unavailable or this Order has a recorded answer attempt" };
    }
    case "hunt-rps": return validateRpsHunt(state, teamId, op);
    case "rps-commit":
    case "rps-open": {
      const gate = validateOrderSubmission(state, teamId, op.contractId, "duel");
      return gate.ok ? validateRps(state, teamId, op) : gate;
    }
    case "leak":
      // [Issue #645] LEAK's trusted check is exactly the Order gate: the team
      // owns the Order, it is still open, and it permits publishing the raw
      // share. There is no artifact to verify -- the reducer reads the share
      // from the team's own vault in applyLeak, so a participant cannot submit
      // a value at all, let alone a wrong one.
      return validateOrderSubmission(state, teamId, op.contractId, "leak");
    case "hunt": {
      // Same gap "rotate" below already had fixed (Issue #486 PR1 review):
      // before the first tick(), state.nowMs is undefined. Unlike rotate's
      // cooldown check, nothing else in this branch reads state.nowMs at
      // all -- a hunt op supplying the target's ACTUAL secret directly
      // (rather than reconstructing it via Lagrange interpolation from
      // leaked shares, which requires a Contract, which requires a tick())
      // would otherwise validate and apply before the match clock has ever
      // started, leaving applyHunt's huntLog entry with no real elapsed-time
      // meaning to timestamp (see applyHunt's own comment on why it now
      // throws instead of silently recording `atMs: 0` for that case).
      // Rejecting here is what makes that throw structurally unreachable
      // through the validateOp -> applyOp path, the same contract every
      // other applyX function's "invalid op reached apply" throw relies on.
      if (state.nowMs === undefined) {
        return { ok: false, error: "match has not started yet (no tick() has run)" };
      }
      if (op.targetTeamId === teamId) {
        return { ok: false, error: "cannot hunt your own team" };
      }
      const target = state.teams[op.targetTeamId];
      if (!target) return { ok: false, error: `unknown target team "${op.targetTeamId}"` };
      if (op.generation !== target.generation) {
        return {
          ok: false,
          error: `target team is on generation ${target.generation}, not ${op.generation}`,
        };
      }
      if ((hasSuccessfulHunt(state, huntKey(teamId, op.targetTeamId, op.generation)) || hasRecordedHunt(state, teamId, op.targetTeamId, op.generation, "share"))) {
        return { ok: false, error: "this generation was already hunted successfully by this team" };
      }
      // [Issue #696] The attempt budget, and the reason a wrong secret is NOT
      // refused here any more. Refusing it made a miss free -- no state moved,
      // so nothing counted it -- which was harmless only while the field was
      // 2^61 - 1. In a field a participant can interpolate by hand, free
      // retries are a faster path to the secret than the interpolation, so a
      // miss has to land, cost `scores.wrongHunt`, and spend one of these.
      // `applyHunt` does the comparison and reports which happened.
      const spent = huntCount(state, storedHuntKey(state, huntKey(teamId, op.targetTeamId, op.generation))) ?? 0;
      if (spent >= state.config.maxHuntAttemptsPerTarget) {
        return {
          ok: false,
          error: `no HUNT attempts left against this team's generation ${op.generation} (${state.config.maxHuntAttemptsPerTarget} used)`,
        };
      }
      // `op.recoveredSecret` is untrusted wire input (a participant-submitted
      // string -- see this file's header "WIRE BOUNDARY"), never a `bigint`
      // this reducer can assume it already has. Parse it through the same
      // gate PROVE's proof fields use before doing any bigint arithmetic on
      // it -- a malformed value (wrong JS type after JSON round-trip, a
      // non-canonical literal, an absurdly long string) is rejected here,
      // not left to throw out of `mod()` / `BigInt()` uncaught. A value that
      // does not parse is not an attempt: nothing was guessed, so nothing is
      // charged and no budget is spent.
      const recoveredSecret = parseCanonicalDecimal(op.recoveredSecret);
      if (recoveredSecret === undefined) {
        return { ok: false, error: "recoveredSecret must be a canonical, length-bounded decimal integer" };
      }
      // Match FHE/MPC's remainder rule. An unreduced value is a format error,
      // not a wrong guess: refuse it before applyHunt can charge an attempt.
      if (recoveredSecret >= BigInt(state.config.prime)) {
        return {
          ok: false,
          error: "recoveredSecret must already be reduced -- take the remainder after dividing by the modulus",
        };
      }
      return { ok: true };
    }
    case "fhe": {
      // [Issue #645 Phase 2] Order gate first, then the trusted decrypt.
      const gate = validateOrderSubmission(state, teamId, op.contractId, "fhe");
      if (!gate.ok) return gate;
      const contract = state.contracts.find((c) => c.id === op.contractId);
      if (contract?.task.kind !== "homomorphic-sum") {
        // validateOrderSubmission already refused every Order whose
        // allowedMethods exclude FHE, and only a homomorphic-sum task ever
        // allows it -- so this is unreachable and says so loudly rather than
        // treating a mismatched task as a pass.
        return { ok: false, error: `contract "${op.contractId}" is not a homomorphic-sum order` };
      }
      const submitted = parseStoredCiphertext(op.ciphertext);
      if (!submitted) {
        return {
          ok: false,
          error: "ciphertext components must be canonical, length-bounded decimal integers",
        };
      }
      // Both components must already be field elements. `parseCanonicalDecimal`
      // only bounds the digit count, and the two comparisons below both reduce
      // mod p -- so before this check `(r + p, y + p)` was accepted, which let
      // a participant skip the 「p で割った余り」 step the Order asks for and
      // still score, and put a value on the Public Ledger that is not a field
      // element at all. Leading zeros remain fine: `007` is 7, and 7 is in
      // range.
      if (submitted.r >= BigInt(state.config.prime) || submitted.y >= BigInt(state.config.prime)) {
        return {
          ok: false,
          error: "ciphertext components must already be reduced -- take the remainder after dividing by the modulus",
        };
      }
      const prime = BigInt(state.config.prime);
      // BOTH components are checked, and the comment that used to stand here --
      // "a participant who reaches the right plaintext by a different
      // homomorphic route has genuinely done the job" -- was wrong about its
      // own premise. `decryptOrderSum` subtracts this Order's FIXED mask, so
      // exactly one `y` is ever accepted; there is no second route to a
      // different valid `y`. That left `r` as the only free component, and an
      // unchecked `r` accepted `(0, y1 + y2)`: half of the componentwise
      // addition the Order asks for, recorded on the Public Ledger as a
      // ciphertext that is NOT the sum of the two public pairs. Requiring the
      // real `r` therefore rejects no legitimate route, because none exists.
      const expectedR = contract.task.inputs.reduce(
        (acc, input) => mod(acc + BigInt(input.r), prime),
        0n,
      );
      if (mod(submitted.r, prime) !== expectedR) {
        return {
          ok: false,
          error: "submitted ciphertext's first component is not the sum of the Order's first components",
        };
      }
      if (
        decryptOrderSum(submitted, state.seed, op.contractId, prime) !==
        expectedFheSum(state.seed, op.contractId, prime)
      ) {
        return { ok: false, error: "submitted ciphertext does not decrypt to the requested sum" };
      }
      return { ok: true };
    }
    case "mpc": {
      // [Issue #645 Phase 3] Order gate, then compare against the partial this
      // team's own inputs and masks produce. The expected value is re-derived
      // from the seed, never stored, and never handed to another team.
      const gate = validateOrderSubmission(state, teamId, op.contractId, "mpc");
      if (!gate.ok) return gate;
      const contract = state.contracts.find((c) => c.id === op.contractId);
      if (contract?.task.kind !== "masked-total") {
        return { ok: false, error: `contract "${op.contractId}" is not a masked-total order` };
      }
      const submittedPartial = parseCanonicalDecimal(op.partial);
      if (submittedPartial === undefined) {
        return { ok: false, error: "partial must be a canonical, length-bounded decimal integer" };
      }
      // Same hole as the FHE branch above, and fixed with it: the comparison
      // below reduces mod p, so an unreduced partial scored while skipping the
      // remainder step -- and here it was worse, because `applyMpc` puts the
      // submitted value into the published `a + b + c` sum, so one unreduced
      // partial makes the ledger's own arithmetic unreproducible.
      if (submittedPartial >= BigInt(state.config.prime)) {
        return {
          ok: false,
          error: "partial must already be reduced -- take the remainder after dividing by the modulus",
        };
      }
      const prime = BigInt(state.config.prime);
      if (mod(submittedPartial, prime) !== expectedMpcPartial(state.seed, op.contractId, prime)) {
        return { ok: false, error: "submitted partial does not match this office's masked total" };
      }
      return { ok: true };
    }
    case "hunt-sudoku": {
      if (state.config.proofProtocol === "schnorr-v1") return {ok:false,error:"new matches use Schnorr; Sudoku recovery is a legacy method"};
      // [Issue #709] Same preconditions as a Shamir HUNT -- see that branch for
      // why each exists -- and a different piece of evidence.
      if (state.nowMs === undefined) {
        return { ok: false, error: "match has not started yet (no tick() has run)" };
      }
      if (op.targetTeamId === teamId) {
        return { ok: false, error: "cannot hunt your own team" };
      }
      const target = state.teams[op.targetTeamId];
      if (!target) return { ok: false, error: `unknown target team "${op.targetTeamId}"` };
      if (op.generation !== target.generation) {
        return {
          ok: false,
          error: `target team is on generation ${target.generation}, not ${op.generation}`,
        };
      }
      if ((hasSuccessfulHunt(state, sudokuHuntKey(teamId, op.targetTeamId, op.generation)) || hasRecordedHunt(state, teamId, op.targetTeamId, op.generation, "sudoku"))) {
        return { ok: false, error: "this generation's solution was already recovered by this team" };
      }
      // The exploit has to be real, not merely claimed: the target must
      // actually have published two reveals under one relabelling. Without
      // this check a team could simply SOLVE the target's public puzzle (eight
      // givens pin a unique solution most of the time) and call it a hunt --
      // and #645's rule is that HUNT punishes misuse, so the misuse has to be
      // on the record.
      if (!hasPermutationReuse(state, op.targetTeamId, op.generation)) {
        return {
          ok: false,
          error: `team "${op.targetTeamId}" has not reused a relabelling in generation ${op.generation}`,
        };
      }
      // ...and the reuse has to have actually given the solution away. Two
      // reveals of one group under one tag are the same four digits twice;
      // a HUNT on that would be a guess, not a recovery.
      if (!isSolutionRecoverable(state, op.targetTeamId, op.generation)) {
        return {
          ok: false,
          error: `team "${op.targetTeamId}" reused a relabelling in generation ${op.generation}, but its opened groups do not yet pin one solution against its public puzzle`,
        };
      }
      // [Issue #696] Same budget logic as the Shamir HUNT, on its own counter.
      // There are only 288 solutions and a public puzzle rules most of them
      // out, so free retries would be cheaper than lining the reveals up.
      const spent = huntCount(state, storedHuntKey(state, sudokuHuntKey(teamId, op.targetTeamId, op.generation))) ?? 0;
      if (spent >= state.config.maxHuntAttemptsPerTarget) {
        return {
          ok: false,
          error: `no sudoku HUNT attempts left against this team's generation ${op.generation} (${state.config.maxHuntAttemptsPerTarget} used)`,
        };
      }
      // Untrusted wire input: checked by SHAPE before any cell is read. A grid
      // that is not 16 digits in 1..4 is not an attempt -- nothing was guessed,
      // so nothing is charged. Whether the digits are RIGHT is decided in
      // `applyHuntSudoku`, so that a wrong answer is a move that landed.
      if (!isFullGridShape(op.solution)) {
        return { ok: false, error: "solution must be 16 cells, row-major, each 1..4" };
      }
      return { ok: true };
    }
    case "reveal-hint": {
      // [Issue #659 §9] Not `validateOrderSubmission`: that gate asks whether a
      // METHOD may answer this Order, and opening a hint answers nothing. The
      // three conditions that do apply are the ownership and open-ness half of
      // it, spelled out here rather than by passing a fake method through a
      // function whose next check would be "can LEAK perform this task".
      const contract = state.contracts.find((c) => c.id === op.contractId);
      if (!contract) return { ok: false, error: `contract "${op.contractId}" not found` };
      if (contract.teamId !== teamId) {
        return { ok: false, error: `contract "${op.contractId}" belongs to another team` };
      }
      if (contract.status !== "open") {
        // A hint on a finished Order teaches nothing it can be used on, and
        // charging for it would be a way to lose points by misclicking a card
        // that has already scrolled into the completed part of the belt.
        return { ok: false, error: `contract "${op.contractId}" is ${contract.status}, not open` };
      }
      const level = hintsRevealedOn(contract);
      const ladder = hintsFor(contract.task.kind);
      if (level >= ladder.length) {
        return { ok: false, error: `contract "${op.contractId}" has no hints left` };
      }
      if (op.expectedCost !== undefined && (!Number.isFinite(op.expectedCost) || op.expectedCost < 0
        || op.expectedCost !== hintPrice(state, teamId, level))) {
        return { ok: false, error: "Hint penalty changed. Refresh and check the displayed penalty before opening." };
      }
      if (hintCostAt(state.config.scores.hintCosts, level) === undefined) {
        // A price list shorter than the ladder. `needsConfigMigration` fills in
        // a missing list entirely, so this is a hand-edited or hand-tuned
        // config -- refuse rather than charge an amount nobody chose.
        return { ok: false, error: `no configured price for hint level ${level}` };
      }
      return { ok: true };
    }
    case "rotate": {
      // Before the first tick(), `state.nowMs` is undefined and so is every
      // team's `lastRotateAtMs`, which used to make the cooldown check below
      // vacuously pass -- a team could ROTATE any number of times before the
      // match clock ever advances. Reject outright instead of silently
      // skipping the cooldown it cannot yet measure.
      if (state.nowMs === undefined) {
        return { ok: false, error: "match has not started yet (no tick() has run)" };
      }
      if (team.lastRotateAtMs !== undefined) {
        const sinceLastRotateMs = state.nowMs - team.lastRotateAtMs;
        if (sinceLastRotateMs < state.config.rotateCooldownMs) {
          return {
            ok: false,
            error: `rotate is on cooldown for ${state.config.rotateCooldownMs - sinceLastRotateMs}ms more`,
          };
        }
      }
      return { ok: true };
    }
    case "anamorphic": {
      const gate=validateOrderSubmission(state,teamId,op.contractId,"anamorphic");
      if(!gate.ok)return gate;
      const task=state.contracts.find(c=>c.id===op.contractId)!.task;
      if(task.kind!=="anamorphic-rejection")return {ok:false,error:"Wrong Order kind"};
      if(task.exercise)return parseAnamorphicAnswer(op.answer,task)?{ok:true}:{ok:false,error:task.exercise==="probability"?"Enter one ticket total (3–9).":"Enter one answer (1–6)."};
      return parseAnamorphicAnswer(op.answer)?{ok:true}:{ok:false,error:"Enter trial number (1–6), ordinary message (1–6) and accepted-ticket total (3–9), separated by spaces."};
    }
    case "stark": {
      const gate=validateOrderSubmission(state,teamId,op.contractId,"stark");
      if(!gate.ok)return gate;
      return parseStarkAnswer(op.answer)?{ok:true}:{ok:false,error:"Enter four remainders (0–6), separated by spaces."};
    }
    case "io": {
      const gate=validateOrderSubmission(state,teamId,op.contractId,"io");
      if(!gate.ok)return gate;
      return parseIoAnswer(op.answer)?{ok:true}:{ok:false,error:"Enter two outputs (0–4), equivalence (0/1), and shared outcome count (0–4), separated by spaces."};
    }
    case "evolution": {
      const gate = validateOrderSubmission(state, teamId, op.contractId, "evolution");
      if (!gate.ok) return gate;
      const order = state.contracts.find(c=>c.id===op.contractId)!;
      const expectedLength = order.task.kind === "ecdsa-sign" ? 2 : 1;
      const answer = parseEvolutionAnswer(op.answer);
      return answer?.length === expectedLength ? {ok:true} : {ok:false,error:`Enter ${expectedLength} space-separated digits.`};
    }
    case "snark": {
      const gate=validateOrderSubmission(state,teamId,op.contractId,"snark");
      if(!gate.ok)return gate;
      return parseResiduals(op.answer)?{ok:true}:{ok:false,error:"Enter five remainders (0–6), separated by spaces."};
    }
    case "ec": {
      const gate=validateOrderSubmission(state,teamId,op.contractId,"ec");
      if(!gate.ok)return gate;
      return parsePoint(op.answer)!==undefined?{ok:true}:{ok:false,error:"Enter x space y (0–6), or O for infinity; the point must lie on the curve."};
    }
    case "schnorr-commit":
    case "schnorr-response": {
      const gate = validateOrderSubmission(state, teamId, op.contractId, "prove");
      if (!gate.ok) return gate;
      if (state.config.proofProtocol !== "schnorr-v1") return {ok:false,error:"this match uses the legacy Sudoku model"};
      const contract = state.contracts.find(c => c.id === op.contractId)!;
      if (op.kind === "schnorr-commit") {
        if (contract.schnorr) return {ok:false,error:"commitment is already fixed; answer its challenge"};
        return group(op.a) && op.y === schnorrStatement(state.seed, teamId, contract.id) ? {ok:true} : {ok:false,error:"commitment must belong to the order-11 subgroup"};
      }
      if (!contract.schnorr || contract.schnorr.used) return {ok:false,error:"commit first; each challenge accepts one response"};
      return scalar(op.z) ? {ok:true} : {ok:false,error:"response must be an integer from 0 to 10"};
    }
    case "prove-sudoku": {
      if (state.config.proofProtocol === "schnorr-v1") return {ok:false,error:"this match requires the interactive Schnorr proof"};
      // [Issue #645] Same Order gate as every other method -- PROVE is a second
      // way to fulfil an Order, not a different queue of things to fulfil.
      const gate = validateOrderSubmission(state, teamId, op.contractId, "prove");
      if (!gate.ok) return gate;
      // Untrusted wire input: shape first, before any cell is compared.
      if (!isFullGridShape(op.grid)) {
        return { ok: false, error: "grid must be 16 cells, row-major, each 1..4" };
      }
      // [Issue #709] The one submission refused before it can cost anything:
      // the solution itself, unrelabelled. It would VERIFY -- the identity is
      // a bijection -- and the judge would then publish four real cells of the
      // team's solution for no reason. A team that has not relabelled has not
      // done the Order, and telling them so is cheaper than charging them.
      const solution = deriveSudokuSolution(state.seed, teamId, team.generation);
      if (solution.every((v, i) => v === op.grid[i])) {
        return {
          ok: false,
          error: "that is your solution as it is -- relabel the digits before submitting, or the reveal publishes real cells",
        };
      }
      // Whether the grid IS a relabelling of the solution is decided in
      // `applyProveSudoku`, for the same reason a wrong HUNT moved there in
      // #696: a wrong answer has to be a move that happened and was charged.
      return { ok: true };
    }
    case "cipher": {
      // [Issue #659] Same Order gate as every other method, then the rung's own
      // check. The judge holds the key -- it derives it from the same
      // (seed, teamId, generation) the team's own projection does -- so this is
      // a straight comparison against the right answer. That is what makes
      // "do the work yourself" a real option on the ladder without needing a
      // zero-knowledge proof for it: nothing is published either way, so there
      // is nothing to prove knowledge WITHOUT revealing.
      const gate = validateOrderSubmission(state, teamId, op.contractId, "cipher");
      if (!gate.ok) return gate;
      const contract = state.contracts.find((c) => c.id === op.contractId);
      if (contract?.task.kind !== "caesar-shift" && contract?.task.kind !== "rsa-encrypt" && contract?.task.kind !== "rotor-encrypt") {
        // Unreachable through the gate above, which already checked the method
        // can perform the task. Fail loudly rather than reading `rung` off a
        // task that has none.
        return { ok: false, error: "contract is not a cipher-ladder Order" };
      }
      // Untrusted wire input -- an arbitrary array of arbitrary strings after a
      // JSON round-trip. Parsed through the rung's own gate, which rejects
      // anything outside the alphabet rather than letting it reach arithmetic.
      const answer = contract.task.kind === "rotor-encrypt" ? parseRotorAnswer(op.answer) : contract.task.kind === "rsa-encrypt" ? parseRsaAnswer(op.answer, contract.task.n) : parseAnswer(op.answer, contract.task.rung);
      if (answer === undefined) {
        return { ok: false, error: contract.task.kind === "rotor-encrypt" ? "enter exactly four integers from 0 to 3" : contract.task.kind === "rsa-encrypt" ? "enter one decimal integer from 0 up to n-1" : "answer must use this Order's symbols, or their values" };
      }
      const expected = contract.task.kind === "rotor-encrypt" ? rotorEncrypt(contract.task.plaintext, deriveRotorPositions(state.seed, teamId, team.generation)) : contract.task.kind === "rsa-encrypt" ? [rsaEncrypt(contract.task.plaintext, contract.task)] : expectedCipherAnswer(state, teamId, contract.task.rung, contract.id);
      if (answer.length !== expected.length) {
        return {
          ok: false,
          error: `answer has ${answer.length} symbols, the Order asks for ${expected.length}`,
        };
      }
      if (contract.task.kind === "caesar-shift" && contract.task.rung !== "vigenere" && answer.some((value, position) => value !== expected[position])) {
        // Deliberately does not say WHICH position is wrong. The Order is a
        // hand calculation with a deadline; turning the judge into a checker
        // that walks a team to the answer would replace the calculation with a
        // guessing loop.
        return { ok: false, error: "ciphertext does not match this Order" };
      }
      return { ok: true };
    }
    case "hunt-rotor": {
      if (state.nowMs === undefined) return { ok: false, error: "match has not started" };
      if (typeof op.targetTeamId !== "string" || op.targetTeamId === teamId || !Object.hasOwn(state.teams, op.targetTeamId)) return { ok: false, error: "choose another team" };
      const target = state.teams[op.targetTeamId]!;
      if (!Number.isSafeInteger(op.generation) || op.generation !== target.generation) return { ok: false, error: "select the current target generation" };
      if (hasRotorHunt(state, teamId, target.teamId, op.generation)) return { ok: false, error: "Rotor already hunted on this generation" };
      if (!decodeLedger(state.publicLedger, state.teams).some(a => a.kind === "rotor-pair" && a.method === "leak" && a.teamId === target.teamId && a.generation === op.generation)) return { ok: false, error: "Rotor HUNT needs a public Rotor pair from this generation" };
      if (!rotorValue(op.a) || !rotorValue(op.b)) return { ok: false, error: "enter initial a and b as integers 0..3" };
      const spent = huntCount(state, storedHuntKey(state, huntKey(teamId, target.teamId, op.generation))) ?? 0;
      return spent < state.config.maxHuntAttemptsPerTarget ? { ok: true } : { ok: false, error: "no shared HUNT attempts left against this generation" };
    }
    case "hunt-rsa": {
      if (state.phase !== "endgame") return { ok: false, error: "RSA public keys are available during endgame" };
      if (typeof op.targetTeamId !== "string" || op.targetTeamId === teamId || !Object.hasOwn(state.teams, op.targetTeamId)) return { ok: false, error: "choose another team" };
      const target = state.teams[op.targetTeamId];
      if (!target || !Number.isSafeInteger(op.generation) || op.generation < 1 || op.generation !== target.generation) return { ok: false, error: "select the current target generation" };
      if (hasSuccessfulHunt(state, rsaHuntKey(state, teamId, target.teamId, target.generation)) || hasRecordedHunt(state, teamId, target.teamId, target.generation, "rsa")) return { ok: false, error: "RSA already hunted on this generation" };
      const { n } = deriveRsaKey(state.seed, target.teamId, target.generation);
      return rsaFactorsFit(n, op.p, op.q) ? { ok: true } : { ok: false, error: "enter two distinct prime factors whose product is the public n" };
    }
    case "hunt-cipher": {
      if (!isCipherRung(op.rung)) return { ok: false, error: "unknown cipher rung" };
      if (state.nowMs === undefined) {
        return { ok: false, error: "match has not started yet (no tick() has run)" };
      }
      if (op.targetTeamId === teamId) {
        return { ok: false, error: "cannot hunt your own team" };
      }
      const target = state.teams[op.targetTeamId];
      if (!target) return { ok: false, error: `unknown target team "${op.targetTeamId}"` };
      if (op.generation !== target.generation) {
        // [Issue #659 §10] A ROTATE is what retires published pairs. The record
        // still shows them, but they belong to a key nobody uses any more --
        // which is the ladder's version of the same defence the Shamir hunt
        // already has, and it works here only because the ladder key is derived
        // per generation (see `deriveCipherKey`).
        return {
          ok: false,
          error: `target team is on generation ${target.generation}, not ${op.generation}`,
        };
      }
      if (hasSuccessfulHunt(state, cipherHuntKey(teamId, op.targetTeamId, op.generation, op.rung))) {
        return { ok: false, error: "this rung was already broken by this team on this generation" };
      }
      if (op.rung === "vigenere") {
        const pairs = decodeLedger(state.publicLedger, state.teams).filter((a): a is CipherPairArtifact =>
          a.kind === "cipher-pair" && a.teamId === op.targetTeamId && a.generation === op.generation && a.rung === op.rung);
        if (exposedKeyPositions(pairs, op.rung).length < rungSpec(op.rung).keyLength) {
          return { ok: false, error: "Vigenere HUNT requires public pairs covering all three key positions in this generation" };
        }
      }
      if (!validCipherKey(op.recoveredKey, op.rung)) {
        return { ok: false, error: "recoveredKey must contain this rung's number of shifts, each within its alphabet" };
      }
      if (JSON.stringify(op.recoveredKey) !== JSON.stringify(deriveCipherKey(state.seed, op.targetTeamId, op.generation, op.rung))) {
        return { ok: false, error: "that is not this team's key" };
      }
      return { ok: true };
    }
    default: {
      const exhaustive: never = op;
      return { ok: false, error: `unknown op kind ${JSON.stringify(exhaustive)}` };
    }
  }
}

/**
 * [Issue #659] The ciphertext this Order's team owes, computed by the judge
 * from the key it derives itself.
 *
 * Shared by `validateOp` (to check a submission) and `projectForTeam` (to hand
 * the team its own key) so the answer a participant is graded against and the
 * key they are told to use can never come from two different derivations.
 */
function expectedCipherAnswer(
  state: CryptoBattleState,
  teamId: string,
  rung: CipherRung,
  contractId: string,
): readonly number[] {
  const generation = state.teams[teamId]?.generation ?? 1;
  const key = deriveCipherKey(state.seed, teamId, generation, rung);
  const task = state.contracts.find(c => c.id === contractId)?.task;
  if (task?.kind !== "caesar-shift") throw new Error("missing stored cipher task");
  return encryptWithRung(task.plaintext, key, rung, task.keyPosition ?? 0);
}

/**
 * Distinct from {@link huntKey} so breaking a team's Caesar key and
 * reconstructing their Shamir secret are separately once-only. They are
 * different breaks of different secrets; sharing a key would let either one
 * silently block the other.
 */
function cipherHuntKey(
  attackerTeamId: string,
  targetTeamId: string,
  generation: number,
  rung: CipherRung,
): string {
  return JSON.stringify(["cipher", attackerTeamId, targetTeamId, generation, rung]);
}

/**
 * [Issue #709] Distinct from {@link huntKey} for the reason {@link
 * cipherHuntKey} is: recovering a team's sudoku solution and reconstructing
 * its Shamir secret are different breaks of different secrets, each once-only
 * on its own and each with its own attempt budget.
 */
function sudokuHuntKey(attackerTeamId: string, targetTeamId: string, generation: number): string {
  return JSON.stringify(["sudoku", attackerTeamId, targetTeamId, generation]);
}

function applyLeak(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "leak" }>,
): CryptoBattleState {
  const contract = state.contracts.find((c) => c.id === op.contractId);
  const team = state.teams[teamId];
  if (!contract || !team) {
    // validateOp() must reject before this is reached; a caller that skips
    // validation gets a loud failure, never a silent no-op state change.
    throw new Error("applyOp(leak): invalid op reached apply -- call validateOp() first");
  }

  const nowMs = state.nowMs ?? contract.issuedAtMs;

  // [Issue #659] LEAK means the same thing on both Orders that accept it --
  // "let the system answer, and live with the answer being public" -- but WHAT
  // becomes public differs, because the two Orders ask for different things. A
  // share Order publishes a point on the secret's polynomial; a ladder Order
  // publishes the (plaintext, ciphertext) pair, which is the material that
  // recovers a key. Branching here rather than at the call site keeps one
  // scoring path: both pay `leakPoints`, both close the Order the same way.
  if (contract.task.kind === "rotor-encrypt" || contract.task.kind === "caesar-shift" || contract.task.kind === "rsa-encrypt") {
    return applyLadderLeak(state, teamId, contract, contract.task, nowMs);
  }
  if (contract.task.kind !== "reveal-share") {
    throw new Error("applyOp(leak): contract is not a reveal-share order -- call validateOp() first");
  }
  const artifacts: PublicArtifact[] = contract.task.shareIndices.map((shareIndex: number) => {
    const shareEntry = team.shares.find((s) => s.index === shareIndex);
    if (!shareEntry) {
      throw new Error(`applyOp(leak): team "${teamId}" has no share at index ${shareIndex}`);
    }
    return {
      id: `${contract.id}-share${shareIndex}`,
      teamId,
      generation: team.generation,
      kind: "share",
      method: "leak",
      shareIndex,
      // `shareEntry.value` is already a stringified bigint (`StoredShare`,
      // see types.ts) -- no `.toString()` needed to reach the ledger's own
      // stringified-bigint `ShareArtifact.value`.
      value: shareEntry.value,
      contractId: contract.id,
      postedAtMs: nowMs,
    };
  });

  const contracts = state.contracts.map((c) =>
    c.id === contract.id ? { ...c, status: "completed" as const, resolution: "leak" as const } : c,
  );
  const updatedTeam: TeamState = {
    ...team,
    // [Issue #659] The leak rate, not the full rate. Paying the same for both
    // made LEAK strictly dominant — no computation, identical payout.
    score: team.score + contract.leakPoints,
    disclosureRotationCost: contract.privacyConstraint === "must-disclose" ? Math.abs(state.config.scores.expiredOrder) : team.disclosureRotationCost,
    completedContractIds: [...team.completedContractIds, compactContractId(teamId, contract.id)],
  };

  return {
    ...state,
    contracts,
    publicLedger: [...state.publicLedger, ...encodeLedger(artifacts, state.teams)],
    teams: { ...state.teams, [teamId]: updatedTeam },
  };
}

/**
 * [Issue #659] LEAK on a ladder Order: the judge answers, and the pair is
 * published.
 *
 * This is the rung's entire lesson made mechanical. The team saves the whole
 * hand calculation and takes `leakPoints`, and in exchange the public record
 * gains a plaintext next to its ciphertext -- which on the bottom rung is one
 * subtraction away from their key. Vigenère exposes positions separately,
 * Rotor pairs constrain initial states, and RSA uses public factors without LEAK.
 */
function applyLadderLeak(
  state: CryptoBattleState,
  teamId: string,
  contract: Contract,
  task: Extract<OrderTask, { kind: "caesar-shift" | "rsa-encrypt" | "rotor-encrypt" }>,
  nowMs: number,
): CryptoBattleState {
  const team = state.teams[teamId];
  if (!team) throw new Error("applyOp(leak): unknown team -- call validateOp() first");
  const answer = task.kind === "rotor-encrypt" ? rotorEncrypt(task.plaintext, deriveRotorPositions(state.seed, teamId, team.generation)) : task.kind === "rsa-encrypt" ? [rsaEncrypt(task.plaintext, task)] : expectedCipherAnswer(state, teamId, task.rung, contract.id);
  const artifact: PublicArtifact = task.kind === "rotor-encrypt" ? {
    id: `${contract.id}-pair`, teamId, generation: team.generation, kind: "rotor-pair", method: "leak", contractId: contract.id,
    plaintext: task.plaintext, ciphertext: answer, postedAtMs: nowMs,
  } : task.kind === "rsa-encrypt" ? {
    id: `${contract.id}-pair`, teamId, generation: team.generation, kind: "rsa-pair", method: "leak", contractId: contract.id,
    n: task.n, e: task.e, plaintext: task.plaintext, ciphertext: answer[0]!, postedAtMs: nowMs,
  } : {
    id: `${contract.id}-pair`,
    teamId,
    generation: team.generation,
    kind: "cipher-pair",
    method: "leak",
    contractId: contract.id,
    rung: task.rung,
    ...(task.keyPosition === undefined ? {} : { keyPosition: task.keyPosition }),
    plaintext: task.plaintext,
    ciphertext: answer,
    postedAtMs: nowMs,
  };
  return {
    ...state,
    contracts: state.contracts.map((c) =>
      c.id === contract.id ? { ...c, status: "completed" as const, resolution: "leak" as const } : c,
    ),
    publicLedger: [...state.publicLedger, encodeArtifact(artifact, state.teams)],
    teams: {
      ...state.teams,
      [teamId]: {
        ...team,
        score: team.score + contract.leakPoints,
        completedContractIds: [...team.completedContractIds, compactContractId(teamId, contract.id)],
      },
    },
  };
}

/**
 * [Issue #659] CIPHER: the team did the hand calculation, and nothing is
 * published.
 *
 * `validateOp` has already checked the answer against the judge's own
 * derivation, so this only has to close the Order and pay -- the same shape
 * `applyProve` has, and for the same reason: the two are the "do the work
 * yourself" methods on their respective Orders.
 */
function applyCipher(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "cipher" }>,
): CryptoBattleState {
  const contract = state.contracts.find((c) => c.id === op.contractId);
  const team = state.teams[teamId];
  if (!contract || !team || (contract.task.kind !== "caesar-shift" && contract.task.kind !== "rsa-encrypt" && contract.task.kind !== "rotor-encrypt")) {
    throw new Error("applyOp(cipher): invalid op reached apply -- call validateOp() first");
  }
  const answer = contract.task.kind === "rotor-encrypt" ? parseRotorAnswer(op.answer) : contract.task.kind === "rsa-encrypt" ? parseRsaAnswer(op.answer, contract.task.n) : parseAnswer(op.answer, contract.task.rung);
  const expected = contract.task.kind === "rotor-encrypt" ? rotorEncrypt(contract.task.plaintext, deriveRotorPositions(state.seed, teamId, team.generation)) : contract.task.kind === "rsa-encrypt" ? [rsaEncrypt(contract.task.plaintext, contract.task)] : expectedCipherAnswer(state, teamId, contract.task.rung, contract.id);
  if (!answer || answer.length !== expected.length) throw new Error("applyOp(cipher): malformed answer reached apply");
  if (answer.some((value, position) => value !== expected[position])) {
    if (contract.task.kind === "caesar-shift" && contract.task.rung !== "vigenere") throw new Error("applyOp(cipher): wrong Caesar answer reached apply");
    const score = Math.max(0, team.score - state.config.scores.wrongProve);
    return { ...state,
      contracts: state.contracts.map(c => c.id === contract.id ? { ...c, cipherFailed: true } : c),
      teams: { ...state.teams, [teamId]: { ...team, score,
        lastCipher: { contractId: contract.id, outcome: "miss", points: score - team.score },
      } },
    };
  }
  const points = contract.cipherFailed === true ? 0 : contract.points + lightningBonus(state, contract);
  return {
    ...state,
    contracts: state.contracts.map((c) =>
      c.id === contract.id
        ? { ...c, status: "completed" as const, resolution: "cipher" as const }
        : c,
    ),
    teams: {
      ...state.teams,
      [teamId]: {
        ...team,
        score: team.score + points,
        lastCipher: { contractId: contract.id, outcome: "hit", points },
        completedContractIds: [...team.completedContractIds, compactContractId(teamId, contract.id)],
      },
    },
  };
}

/** A stateful-cipher attempt uses the existing shared HUNT budget and prices.
 * The exact-time success record also prevents another reward for this pairing. */
function applyHuntRotor(state: CryptoBattleState, teamId: string, op: Extract<CryptoBattleOp, { kind: "hunt-rotor" }>): CryptoBattleState {
  const attacker = state.teams[teamId], target = state.teams[op.targetTeamId];
  if (!attacker || !target || state.nowMs === undefined) throw new Error("Rotor HUNT requires a validated op");
  const key = storedHuntKey(state, huntKey(teamId, target.teamId, op.generation));
  const huntAttempts = changeHuntCount(state, key, 1);
  const initial = deriveRotorPositions(state.seed, target.teamId, op.generation);
  const hit = initial.a === op.a && initial.b === op.b;
  const score = hit ? attacker.score + state.config.scores.huntBonus : Math.max(0, attacker.score - state.config.scores.wrongHunt);
  const teams = { ...state.teams, [teamId]: { ...attacker, score,
    lastHunt: storeLastHunt(state, { targetTeamId: target.teamId, generation: op.generation, via: "rotor" as const, outcome: hit ? "hit" as const : "miss" as const, points: score - attacker.score }),
  } };
  if (!hit) return { ...state, teams, huntAttempts };
  const broken = target.cipherHuntedGenerations.rotor ?? [];
  teams[target.teamId] = { ...target, score: Math.max(0, target.score - state.config.scores.huntPenalty),
    cipherHuntedGenerations: { ...target.cipherHuntedGenerations, rotor: broken.includes(op.generation) ? broken : [...broken, op.generation] } };
  return { ...state, teams, huntAttempts,
    huntLog: appendRotorHunt(state, teamId, target.teamId, op.generation),
  };
}

function applyHuntCipher(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "hunt-cipher" | "hunt-rsa" }>,
): CryptoBattleState {
  const attacker = state.teams[teamId];
  const target = state.teams[op.targetTeamId];
  if (!attacker || !target) {
    throw new Error("applyOp(hunt-cipher): invalid op reached apply -- call validateOp() first");
  }
  const rung = op.kind === "hunt-rsa" ? "rsa" : op.rung;
  const bonus = rung === "rsa" ? state.config.scores.huntBonus : rungSpec(rung).huntBonus;
  const broken = target.cipherHuntedGenerations[rung] ?? [];
  const huntLog = rung === "rsa" ? appendRsaHunt(state, teamId, op.targetTeamId, op.generation) : state.huntLog;
  return {
    ...state,
    huntLog,
    teams: {
      ...state.teams,
      [teamId]: { ...attacker, score: attacker.score + bonus },
      [op.targetTeamId]: {
        ...target,
        score: Math.max(0, target.score - state.config.scores.huntPenalty),
        cipherHuntedGenerations: {
          ...target.cipherHuntedGenerations,
          [rung]: broken.includes(op.generation) ? broken : [...broken, op.generation],
        },
      },
    },
    successfulHunts: rung === "rsa" ? state.successfulHunts : recordSuccessfulHunt(state, cipherHuntKey(teamId, op.targetTeamId, op.generation, rung)),
  };
}

/**
 * [Issue #645 Phase 2] Record an accepted FHE submission.
 *
 * The ciphertext goes on the Public Ledger verbatim. That is safe and it is the
 * lesson: everyone can see that this team answered, and nobody — including the
 * teams who can read the Order's input ciphertexts — learns anything about the
 * numbers involved. See fhe.ts on why that is information-theoretic.
 */
function applyFhe(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "fhe" }>,
): CryptoBattleState {
  const contract = state.contracts.find((c) => c.id === op.contractId);
  const team = state.teams[teamId];
  if (!contract || !team) {
    throw new Error("applyOp(fhe): invalid op reached apply -- call validateOp() first");
  }

  const nowMs = state.nowMs ?? contract.issuedAtMs;
  // Re-serialized through BigInt(...).toString() for the same reason applyProve
  // does it: validateOp has already forced both components through
  // parseCanonicalDecimal, so this guarantees the ledger only ever holds the
  // canonical form rather than whatever the submission happened to carry.
  const artifact: CiphertextArtifact = {
    id: `${contract.id}-ciphertext`,
    teamId,
    generation: team.generation,
    kind: "ciphertext",
    method: "fhe",
    contractId: contract.id,
    r: BigInt(op.ciphertext.r).toString(),
    y: BigInt(op.ciphertext.y).toString(),
    postedAtMs: nowMs,
  };

  return completeOrder(state, teamId, contract, artifact, "fhe");
}

/**
 * [Issue #645 Phase 3] Record an accepted MPC submission.
 *
 * The masked partial goes on the Public Ledger, and the team's own number never
 * does. Publishing the partial is what lets the client add the three offices'
 * partials and learn the total — the point of the protocol — while every
 * individual figure stays hidden. See mpc.ts.
 */
function applyMpc(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "mpc" }>,
): CryptoBattleState {
  const contract = state.contracts.find((c) => c.id === op.contractId);
  const team = state.teams[teamId];
  if (!contract || !team) {
    throw new Error("applyOp(mpc): invalid op reached apply -- call validateOp() first");
  }

  const nowMs = state.nowMs ?? contract.issuedAtMs;
  const prime = BigInt(state.config.prime);
  // [Issue #645 Phase 3] Finish the protocol, not just this office's step.
  //
  // The other two offices publish their partials the moment this one does --
  // that is what the client is waiting for, and the masks only cancel across
  // all three. Recording just this team's partial left the Order's own story
  // unfinished: the participant did the arithmetic, scored, and the result the
  // whole exercise exists to demonstrate never appeared anywhere.
  //
  // The peers are derived, not stored, for the same reason everything else
  // here is: `state` never holds a value a projection would have to remember
  // to redact.
  const peers = allPartials(state.seed, contract.id, prime).filter(
    (_partial, index) => index !== MPC_TEAM_PARTY_INDEX,
  );
  const artifact: PartialArtifact = {
    id: `${contract.id}-partial`,
    teamId,
    generation: team.generation,
    kind: "partial",
    method: "mpc",
    contractId: contract.id,
    partial: BigInt(op.partial).toString(),
    peerPartials: peers.map((partial) => partial.toString()),
    // Summed from the published partials rather than read from
    // `expectedMpcTotal`, so the ledger shows a number the participant can
    // reproduce by adding the three rows in front of them -- which is the
    // lesson. The two agree; `mpc.test.ts` asserts it.
    total: sumInField([BigInt(op.partial), ...peers], prime).toString(),
    postedAtMs: nowMs,
  };

  return completeOrder(state, teamId, contract, artifact, "mpc");
}

/**
 * [Issue #645] Close one Order: post its artifact, mark it completed with the
 * method that did it, and award its points.
 *
 * Shared by the methods added after Phase 1. LEAK and PROVE keep their own
 * inline versions because each does something extra (LEAK posts one artifact
 * per requested share index; PROVE has a longer note about what its transcript
 * may contain), and folding those into a common helper would hide the part of
 * each that is worth reading. What matters is that the SCORING is one
 * expression, not four: every method earns the Order's stated points, never a
 * bonus for the technique used — #486's rule, unchanged.
 */
/**
 * [Issue #659 §9] Open the next hint on an Order and charge for it.
 *
 * Publishes nothing. A hint is the only move in this Battle that changes a
 * team's score without touching the Public Ledger -- deliberately, because the
 * point of the item #659 §9 builds on top of this (the booster) is to help the
 * team in last place without announcing to the rest of the field that they
 * needed help.
 *
 * The deduction floors at 0, the same convention `applyHunt` and
 * `applyExpiryPenalties` already use for every other penalty in this file.
 */
function hintPrice(state: CryptoBattleState, teamId: string, level: number): number | undefined {
  const price = hintCostAt(state.config.scores.hintCosts, level);
  return price === undefined ? undefined : projectBooster(state, teamId).status === "active" ? 0 : price;
}

function applyRevealHint(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "reveal-hint" }>,
): CryptoBattleState {
  const team = state.teams[teamId];
  const contract = state.contracts.find((c) => c.id === op.contractId);
  if (!team || !contract) {
    throw new Error("applyRevealHint: unknown team or contract -- call validateOp() first");
  }
  const level = hintsRevealedOn(contract);
  const cost = hintPrice(state, teamId, level);
  if (cost === undefined) {
    throw new Error("applyRevealHint: no configured price -- call validateOp() first");
  }
  return {
    ...state,
    contracts: state.contracts.map((c) =>
      c.id === contract.id ? { ...c, hintsRevealed: level + 1 } : c,
    ),
    teams: {
      ...state.teams,
      [teamId]: { ...team, score: Math.max(0, team.score - cost) },
    },
  };
}

function completeOrder(
  state: CryptoBattleState,
  teamId: string,
  contract: Contract,
  artifact: PublicArtifact,
  method: SubmissionMethod,
): CryptoBattleState {
  const team = state.teams[teamId];
  if (!team) {
    throw new Error("completeOrder: unknown team -- call validateOp() first");
  }
  const contracts = state.contracts.map((c) =>
    c.id === contract.id ? { ...c, status: "completed" as const, resolution: method } : c,
  );
  return {
    ...state,
    contracts,
    publicLedger: [...state.publicLedger, encodeArtifact(artifact, state.teams)],
    teams: {
      ...state.teams,
      [teamId]: {
        ...team,
        score: team.score + contract.points + lightningBonus(state, contract),
        completedContractIds: [...team.completedContractIds, compactContractId(teamId, contract.id)],
      },
    },
  };
}

/**
 * [Issue #645] The task as its owner sees it.
 *
 * `reveal-share` and `homomorphic-sum` pass straight through — their payloads
 * are public. `masked-total` gains the confidential inputs, derived here from
 * the match seed rather than stored, so the only copy that ever exists is the
 * one handed to the team the Order belongs to. `projectForTeam` calls this only
 * for `myContracts`, which is already filtered to that team.
 */
function projectTask(
  state: CryptoBattleState,
  teamId: string,
  task: OrderTask,
  contractId: string,
): OrderTaskProjection {
  switch (task.kind) {
    case "ssm-decrypt": return task;
    case "anamorphic-rejection": return task;
    case "stark-trace": return task;
    case "io-equivalence": return task;
    case "rsa-decrypt":
    case "enigma-encrypt":
    case "ecdsa-sign":
    case "snark-constraints": return task;
    case "ec-add": return task;
    case "rotor-encrypt": {
      const order = state.contracts.find(c => c.id === contractId && c.teamId === teamId);
      if (!order) throw new Error("projectTask: missing owned Rotor Order");
      return { ...task, myInitial: deriveRotorPositions(state.seed, teamId, task.generation) };
    }
    case "rsa-encrypt": return { kind: "rsa-encrypt", n: task.n, e: task.e, plaintext: task.plaintext };
    case "rps-duel": {
      const order = state.contracts.find(c => c.id === contractId);
      if (!order || order.teamId !== teamId) throw new Error("projectTask: missing owned duel");
      return projectRps(state, order);
    }
    case "reveal-share":
      return task;
    case "homomorphic-sum":
      return task;
    case "masked-total": {
      const inputs = deriveMpcPrivateInputs(state.seed, contractId, BigInt(state.config.prime));
      return {
        kind: "masked-total",
        partyCount: task.partyCount,
        myInput: inputs.myInput.toString(),
        incomingMasks: inputs.incomingMasks.map((m) => m.toString()),
        outgoingMasks: inputs.outgoingMasks.map((m) => m.toString()),
      };
    }
    case "caesar-shift": {
      // [Issue #659] The team's own key, added to the public Order.
      //
      // This is not a leak of anything: the key is the team's to begin with,
      // the whole task is to encrypt WITH it, and `projectForTeam` only ever
      // hands a projection to the team it belongs to -- the same boundary
      // `vault.secret` and MPC's `myInput` already sit on. Derived here rather
      // than stored so ROTATE moves it with everything else, and so the key a
      // participant is shown and the key the judge grades against come from one
      // derivation (see `expectedCipherAnswer`).
      const generation = state.teams[teamId]?.generation ?? 1;
      const spec = rungSpec(task.rung);
      return {
        kind: "caesar-shift",
        rung: task.rung,
        // The alphabet and the break threshold are constants of the rung, so
        // they are added here rather than stored on every Order (see
        // `OrderTask`'s `caesar-shift` arm). The plaintext passes through as
        // VALUES -- the Portal draws each symbol rather than relying on a font
        // to have it.
        plaintext: task.plaintext,
        symbols: spec.symbols,
        pairsToBreak: spec.pairsToBreak,
        ...(task.keyPosition === undefined ? {} : { keyPosition: task.keyPosition }),
        myKey: deriveCipherKey(state.seed, teamId, generation, task.rung),
      };
    }
    case "zk-sudoku":
      return task;
    default: {
      const exhaustive: never = task;
      throw new Error(`projectTask: unknown task ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * [Issue #659 §9] This Order's hint ladder as its owner sees it: every level,
 * with the text on the ones they bought and nothing but a price on the rest.
 *
 * This is the redaction that makes the price real, and it is why hint text
 * lives in `hints.ts` on the state side rather than in the Portal's locale
 * tables where every other participant-facing string in this Battle lives. The
 * Portal bundle is shipped to the browser whole; anything compiled into it is
 * free to anyone who opens devtools, and a hint that is free to the players who
 * look is not a hint that costs anything. Only the side holding the state can
 * withhold it, so only the side holding the state may hold it.
 *
 * A missing price yields a `cost` of 0 rather than `NaN` -- `validateOp`
 * refuses to SELL a level with no configured price, so this branch only ever
 * renders one, and rendering it as `NaN` would put that straight on a card.
 */
function projectHints(
  state: CryptoBattleState,
  contract: Contract,
  task: OrderTaskProjection,
  vault: VaultProjection,
  exposedShareIndices: readonly number[],
): readonly HintProjection[] {
  const revealed = hintsRevealedOn(contract);
  // [Issue #712] Rendered against THIS Order and THIS reader's vault -- both of
  // which are already on the projection this hint ships with. Rendered only for
  // the rungs that were bought, so an unbought rung never has its text computed,
  // let alone shipped.
  const ctx: HintContext = {
    task,
    vault,
    prime: state.config.prime,
    threshold: state.config.threshold,
    shareCount: state.config.shareCount,
    allowedMethods: contract.allowedMethods,
    exposedShareIndices,
  };
  return hintsFor(contract.task.kind).map((spec, level) => ({
    level,
    id: spec.id,
    cost: hintPrice(state, vault.teamId, level) ?? 0,
    regularCost: hintCostAt(state.config.scores.hintCosts, level) ?? 0,
    ...(level < revealed ? { text: state.config.proofProtocol === "schnorr-v1" && contract.allowedMethods.includes("prove") ? schnorrHint(level) : spec.text(ctx) } : {}),
  }));
}

function applyHunt(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "hunt" }>,
): CryptoBattleState {
  const attacker = state.teams[teamId];
  const target = state.teams[op.targetTeamId];
  if (!attacker || !target) {
    throw new Error("applyOp(hunt): invalid op reached apply -- call validateOp() first");
  }
  // validateOp's "hunt" branch (above) now rejects before the first tick(),
  // so `state.nowMs` is always defined here for any op that reached this
  // point through the intended validateOp -> applyOp path -- throw loudly
  // (matching the "invalid op reached apply" throw above and every other
  // applyX function's identical pattern) rather than silently recording an
  // untimestamped `huntLog` entry with `atMs: 0`, which would misrepresent
  // when the hunt happened instead of admitting the caller skipped
  // validateOp.
  if (state.nowMs === undefined) {
    throw new Error("applyOp(hunt): invalid op reached apply -- call validateOp() first (match has not started)");
  }
  const nowMs = state.nowMs;

  const key = huntKey(teamId, op.targetTeamId, op.generation);
  const budgetKey = storedHuntKey(state, key);
  const huntAttempts = changeHuntCount(state, budgetKey, 1);

  // [Issue #696] The comparison moved here from `validateOp` so a miss is a
  // move that happened rather than a request that never existed. `validateOp`
  // has already parsed the value and confirmed the budget, so the only question
  // left is whether it is right.
  const recoveredSecret = parseCanonicalDecimal(op.recoveredSecret);
  if (recoveredSecret === undefined || mod(recoveredSecret, BigInt(state.config.prime)) !== BigInt(target.secret)) {
    return {
      ...state,
      teams: {
        ...state.teams,
        [teamId]: {
          ...attacker,
          score: Math.max(0, attacker.score - state.config.scores.wrongHunt),
          // [Issue #696] The miss is written down, not just charged. The SDK
          // answers a landed op with `{ ok: true }` whether it hit or missed,
          // and `projectForTeam` is a pure function of state -- so if the
          // state does not say "that was a miss", nothing downstream can, and
          // the Portal is left calling a -8 a SUCCESS.
          lastHunt: storeLastHunt(state, { targetTeamId: op.targetTeamId, generation: op.generation, outcome: "miss", points: Math.max(0, attacker.score - state.config.scores.wrongHunt) - attacker.score }),
        },
      },
      huntAttempts,
    };
  }

  const updatedAttacker: TeamState = {
    ...attacker,
    score: attacker.score + state.config.scores.huntBonus,
    lastHunt: storeLastHunt(state, { targetTeamId: op.targetTeamId, generation: op.generation, outcome: "hit", points: state.config.scores.huntBonus }),
  };
  const updatedTarget: TeamState = {
    ...target,
    score: Math.max(0, target.score - state.config.scores.huntPenalty),
    huntedGenerations: target.huntedGenerations.includes(op.generation)
      ? target.huntedGenerations
      : [...target.huntedGenerations, op.generation],
  };

  return {
    ...state,
    teams: { ...state.teams, [teamId]: updatedAttacker, [op.targetTeamId]: updatedTarget },
    huntAttempts,
    huntLog: appendShareHunt(state, teamId, op.targetTeamId, op.generation),
  };
}

/** Clearing the batch must not make immediately retiring a paid disclosure free. */
function disclosureRotateMinimum(state: CryptoBattleState, teamId: string): number {
  const cost = state.teams[teamId]?.disclosureRotationCost;
  if (cost === undefined) return 0;
  if (!Number.isFinite(cost) || cost < 0) throw new Error("invalid disclosure rotation cost");
  return cost;
}

function applyRotate(state: CryptoBattleState, teamId: string): CryptoBattleState {
  const team = state.teams[teamId];
  if (!team) {
    throw new Error("applyOp(rotate): invalid op reached apply -- call validateOp() first");
  }
  const generation = team.generation + 1;
  const { secret, shares } = deriveTeamGeneration(state.seed, teamId, generation, fieldConfigOf(state.config));
  const updatedTeam: TeamState = {
    ...team,
    generation,
    secret: secret.toString(),
    shares: shares.map((s): StoredShare => ({ index: s.index, value: s.value.toString() })),
    lastRotateAtMs: state.nowMs,
    disclosureRotationCost: undefined,
  };
  // Rotate's time cost isn't only the cooldown: every contract issued to
  // this team before the rotate is voided along with the old generation.
  // Without this, LEAKing a pre-rotate contract after rotating would just
  // publish a fresh-generation share for free -- a shortcut that defeats the
  // whole point of rotating away from exposure (Issue #486 frames ROTATE as
  // carrying a real compute/time cost; see OPERATOR.md's design note).
  //
  // [Issue #659] Voiding has to cost what letting the batch lapse costs, and
  // #659 does not say so -- it settles the ordering
  // `失効 -15 < LEAK して狩られる -2 < LEAK 無事 +10 < PROVE +30` while assuming
  // PROVE, LEAK and expiry are the only three ways an Order can end. ROTATE is
  // a fourth, and unpriced it dominates all of them: `rotateCooldownMs` (3 min)
  // is shorter than `contractIntervalMs` (5 min), so a team could rotate once
  // per batch, void every Order it had not finished for nothing, publish
  // nothing, and additionally retire whatever it had already leaked. A team
  // that cleared 2 of 6 would choose 0 over LEAK's +40 or expiry's -60 every
  // time, and the opponent-facing half of the game would stop happening --
  // exactly the dead end the #659 simulation found and fixed elsewhere.
  //
  // So the rule is one line and holds whatever ends the Order: an Order that is
  // neither PROVEd nor LEAKed costs `scores.expiredOrder`, exactly once. That
  // keeps ROTATE honest without making it useless -- rotating costs nothing
  // extra when the batch was about to lapse anyway, so WHEN to rotate becomes
  // the decision, rather than whether to rotate instead of playing.
  const voided: string[] = [];
  const contracts = state.contracts.map((c) => {
    if (c.teamId !== teamId || c.status !== "open" || (c.task.kind === "rps-duel" || c.task.kind === "ssm-decrypt")) return c;
    voided.push(c.teamId);
    return { ...c, status: "expired" as const, expiryCause: "rotate" as const };
  });
  // [Issue #709] The sudoku solution and its public puzzle are generation-
  // scoped (see fixtures.ts's `deriveSudokuSolution`): re-deriving the puzzle
  // here is what retires every reveal published under the old generation, the
  // same way rotate already invalidates pre-rotate LEAK shares for HUNT above.
  // A team whose relabellings are used up, or whose solution was recovered,
  // rotates into a fresh grid.
  const publicPuzzles = {
    ...(state.publicPuzzles ?? {}),
    [teamId]: deriveSudokuPuzzle(state.seed, teamId, generation),
  };
  // Charged through the same helper the deadline path uses, so the two causes
  // cannot drift apart into different prices for the same unanswered Order.
  const penalty = rotationPenalty(state, teamId, voided.length);
  const teams = applyExpiryPenalties(
    { ...state.teams, [teamId]: updatedTeam },
    [teamId],
    -penalty,
  );
  return pruneRetiredHuntAttempts(pruneRetiredRsaHunts({ ...state, contracts, teams, publicPuzzles }));
}

/**
 * [Issue #709] PROVE: check the grid is a relabelling of the team's solution,
 * and publish one group of it.
 *
 * The judge derives the solution itself and asks one question: is there a
 * bijection π on 1..4 with `grid = π(S)`? That question has a definite answer
 * -- no challenge, no probability, no round structure -- because the judge
 * sees every cell. A wrong grid is a move that landed: it charges
 * `scores.wrongProve`, is written down as the team's `lastProve`, and
 * publishes nothing.
 *
 * A right grid publishes exactly one row, column or box OF THE SUBMITTED GRID
 * -- never of `S` -- chosen by the Order id (`deriveRevealGroup`). That is the
 * zero-knowledge half, and it holds against every other team: four cells of a
 * relabelled grid are some ordering of 1..4 whatever the solution was. The
 * tag alongside them is what makes a REUSED relabelling visible, and only that
 * (`derivePermutationTag`).
 */
function applyProveSudoku(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "prove-sudoku" }>,
): CryptoBattleState {
  const contract = state.contracts.find((c) => c.id === op.contractId);
  const team = state.teams[teamId];
  if (!contract || !team || !isFullGridShape(op.grid)) {
    throw new Error("applyOp(prove-sudoku): invalid op reached apply -- call validateOp() first");
  }
  const solution = deriveSudokuSolution(state.seed, teamId, team.generation);
  const pi = permutationBetween(solution, op.grid);
  // `permutationBetween` already implies validity (a relabelled solution is a
  // solution), but the check is stated so a reader sees both halves of what
  // the judge asserts: a real sudoku, and THIS team's sudoku.
  if (pi === undefined || !isValidSolution(op.grid) || samePermutation(pi, IDENTITY_PERMUTATION)) {
    return {
      ...state,
      contracts: state.contracts.map(c => c.id === contract.id ? { ...c, answerAttempted: true } : c),
      teams: {
        ...state.teams,
        [teamId]: {
          ...team,
          score: Math.max(0, team.score - state.config.scores.wrongProve),
          lastProve: { contractId: contract.id, outcome: "miss" },
        },
      },
    };
  }
  const nowMs = state.nowMs ?? contract.issuedAtMs;
  const tag = derivePermutationTag(state.seed, teamId, team.generation, pi);
  // A group this generation has not had opened yet while any remain, and
  // failing that one this TABLE has not had opened: a repeated group under a
  // reused table would be the same row twice, and the reuse HUNT the
  // statement promises needs distinct cells to line up.
  const opened = openedGroupsFor(state, teamId, team.generation, tag);
  const group = deriveRevealGroup(state.seed, contract.id, [opened.any, opened.underTag]);
  const cells = CONSTRAINT_GROUPS[group];
  if (!cells) throw new Error(`applyOp(prove-sudoku): no constraint group ${group}`);
  const artifact: SudokuRevealArtifact = {
    id: `${contract.id}-sudoku`,
    teamId,
    generation: team.generation,
    kind: "sudoku-reveal",
    method: "prove",
    contractId: contract.id,
    group,
    cells: cells.map((i) => op.grid[i] ?? 0),
    tag,
    postedAtMs: nowMs,
  };
  const points = contract.points + lightningBonus(state, contract);
  const completed = completeOrder(state, teamId, contract, artifact, "prove");
  const provingTeam = completed.teams[teamId];
  if (!provingTeam) throw new Error("applyOp(prove-sudoku): team vanished while completing the Order");
  return {
    ...completed,
    teams: {
      ...completed.teams,
      [teamId]: { ...provingTeam, lastProve: { contractId: contract.id, outcome: "hit", points } },
    },
  };
}

/**
 * [Issue #709] A sudoku HUNT: the target reused a relabelling, the attacker
 * lined the reveals up against the public puzzle, and here is the solution.
 *
 * Scores like a Shamir HUNT (`huntBonus` / `huntPenalty`), because it is the
 * same size of achievement -- a whole secret recovered from public material --
 * and unlike the ladder break it is not one subtraction. A miss lands, costs
 * `wrongHunt`, and spends one of the attacker's attempts, on the sudoku
 * counter rather than the Shamir one (`sudokuHuntKey`).
 */
function applyHuntSudoku(
  state: CryptoBattleState,
  teamId: string,
  op: Extract<CryptoBattleOp, { kind: "hunt-sudoku" }>,
): CryptoBattleState {
  const attacker = state.teams[teamId];
  const target = state.teams[op.targetTeamId];
  if (!attacker || !target || !isFullGridShape(op.solution)) {
    throw new Error("applyOp(hunt-sudoku): invalid op reached apply -- call validateOp() first");
  }
  if (state.nowMs === undefined) {
    throw new Error("applyOp(hunt-sudoku): invalid op reached apply -- call validateOp() first (match has not started)");
  }
  const nowMs = state.nowMs;
  const key = sudokuHuntKey(teamId, op.targetTeamId, op.generation);
  const budgetKey = storedHuntKey(state, key);
  const huntAttempts = changeHuntCount(state, budgetKey, 1);
  const solution = deriveSudokuSolution(state.seed, op.targetTeamId, op.generation);
  const hit = solution.every((v, i) => v === op.solution[i]);
  if (!hit) {
    return {
      ...state,
      teams: {
        ...state.teams,
        [teamId]: {
          ...attacker,
          score: Math.max(0, attacker.score - state.config.scores.wrongHunt),
          lastHunt: storeLastHunt(state, { targetTeamId: op.targetTeamId, generation: op.generation, outcome: "miss", via: "sudoku", points: Math.max(0, attacker.score - state.config.scores.wrongHunt) - attacker.score }),
        },
      },
      huntAttempts,
    };
  }
  const recovered = target.sudokuHuntedGenerations ?? [];
  return {
    ...state,
    teams: {
      ...state.teams,
      [teamId]: {
        ...attacker,
        score: attacker.score + state.config.scores.huntBonus,
        lastHunt: storeLastHunt(state, { targetTeamId: op.targetTeamId, generation: op.generation, outcome: "hit", via: "sudoku", points: state.config.scores.huntBonus }),
      },
      [op.targetTeamId]: {
        ...target,
        score: Math.max(0, target.score - state.config.scores.huntPenalty),
        sudokuHuntedGenerations: recovered.includes(op.generation) ? recovered : [...recovered, op.generation],
      },
    },
    huntAttempts,
    huntLog: appendSudokuHunt(state, teamId, op.targetTeamId, op.generation),
  };
}

/**
 * [Issue #677] Starts the match: fixes the clock's origin at now and hands the
 * first batch of Orders over immediately.
 *
 * The batch is issued here rather than left to the next scheduled tick because
 * ticks are a minute apart, and a player who presses START and then stares at
 * an empty belt for most of a minute has been told the button did nothing.
 * Running `tick` at the instant of the start is also what keeps the belt's
 * origin and the clock's origin the same value, so the first batch lands at
 * elapsed zero exactly as every later batch lands on its own interval.
 *
 * `nowMs` is absent only before the platform's first tick, which no player can
 * get ahead of in practice; falling back to zero keeps the reducer total for
 * local play and tests, where the caller drives the clock itself.
 */
/**
 * [Issue #688] Marks one team ready, and starts the match once every team is.
 *
 * The roster is `state.teams`, which is fixed when the match materialises, so
 * "everyone" is a question this state can answer on its own. A team that says
 * ready twice changes nothing, which matters because the portal will re-send on
 * a retry and a second READY must not be a second vote.
 */
function applyReady(state: CryptoBattleState, teamId: string): CryptoBattleState {
  const ready = new Set(state.readyTeamIds ?? []);
  ready.add(teamId);
  const waiting = { ...state, readyTeamIds: [...ready].sort() };
  const roster = Object.keys(state.teams);
  return roster.every((id) => ready.has(id)) ? applyStart(waiting) : waiting;
}

function applyStart(state: CryptoBattleState): CryptoBattleState {
  const startedAtMs = state.nowMs ?? 0;
  // [Issue #926] A platform length ends the match at a fixed point on the
  // event clock, so the span left after START is what the phases divide.
  // They stay fixed from here; later reports move only the end.
  const started = { ...state, startedAtMs, nextContractAtMs: startedAtMs, phase: "build" as const };
  return tick(startedTiming(started), startedAtMs);
}

/** A declaration and its terminal result persist in the same operation/state write. */
export function applyOp(state: CryptoBattleState, teamId: string, op: CryptoBattleOp): CryptoBattleState {
  const next = settleLightning(applyMethodOp(state, teamId, op));
  if (op.kind !== "hunt" && op.kind !== "hunt-sudoku" && op.kind !== "hunt-rotor" && op.kind !== "hunt-cipher" && op.kind !== "hunt-rsa") return next;
  const beforeTarget=state.teams[op.targetTeamId], target=next.teams[op.targetTeamId];
  const result=next.teams[teamId]?.lastHunt;
  const hit=op.kind === "hunt-cipher" || op.kind === "hunt-rsa" || (result && readLastHunt(next,result).outcome === "hit");
  if (!hit || !beforeTarget || !target || target === beforeTarget) return next;
  const method=op.kind === "hunt" ? "share" : op.kind === "hunt-sudoku" ? "sudoku" : op.kind === "hunt-rotor" ? "rotor" : op.kind === "hunt-rsa" ? "rsa" : op.rung;
  return {...next,teams:{...next.teams,[op.targetTeamId]:{...target,lastBreach:{
    sequence:(beforeTarget.lastBreach?.sequence ?? 0)+1,attackerTeamId:teamId,generation:op.generation,method,atMs:next.nowMs ?? 0,points:target.score-beforeTarget.score,
  }}}};
}

function applyMethodOp(
  persistedState: CryptoBattleState,
  teamId: string,
  op: CryptoBattleOp,
): CryptoBattleState {
  const state = withMigratedContracts(persistedState);
  switch (op.kind) {
    case "claim-steal":
    case "use-steal": return applySteal(state, teamId, op);
    case "schnorr-commit":
    case "schnorr-response": return applySchnorr(state, teamId, op);
    case "declare-lightning": return armLightning(state, teamId, op.contractId);
    case "hunt-rps": return applyRpsHunt(state, teamId, op);
    case "rps-commit":
    case "rps-open":
      return applyRps(state, teamId, op);
    case "ready":
      return applyReady(state, teamId);
    case "start":
      return applyStart(state);
    case "leak":
      return applyLeak(state, teamId, op);
    case "fhe":
      return applyFhe(state, teamId, op);
    case "anamorphic": return applyAnamorphic(state,teamId,op);
    case "stark": return applyStark(state,teamId,op);
    case "io": return applyIo(state,teamId,op);
    case "evolution": return applyEvolution(state,teamId,op);
    case "snark": return applySnark(state,teamId,op);
    case "ec": return applyEc(state,teamId,op);
    case "mpc":
      return applyMpc(state, teamId, op);
    case "hunt":
      return applyHunt(state, teamId, op);
    case "hunt-sudoku":
      return applyHuntSudoku(state, teamId, op);
    case "rotate":
      return applyRotate(state, teamId);
    case "prove-sudoku":
      return applyProveSudoku(state, teamId, op);
    case "cipher":
      return applyCipher(state, teamId, op);
    case "hunt-rotor": return applyHuntRotor(state, teamId, op);
    case "hunt-rsa":
    case "hunt-cipher":
      return applyHuntCipher(state, teamId, op);
    case "reveal-hint":
      return applyRevealHint(state, teamId, op);
    default: {
      const exhaustive: never = op;
      throw new Error(`applyOp: unknown op kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The only sanctioned read path for a participant. Redacts every team's
 * state down to what `teamId` is allowed to see: their own vault in full,
 * every team's public score/generation, the full Public Ledger (public by
 * construction -- every entry got there via a LEAK's revealed share or a
 * PROVE's opened group), and every team's sudoku puzzle (also public by
 * construction). No other team's `secret`, un-leaked `shares` or sudoku
 * solution ever appears here (adversarial test #5 / prove.test.ts's
 * non-leakage tests assert this).
 */
export function projectForTeam(
  persistedState: CryptoBattleState,
  teamId: string,
): CryptoBattleProjection {
  const state = withMigratedContracts(persistedState);
  const team = state.teams[teamId];
  if (!team) {
    throw new Error(`projectForTeam: unknown team "${teamId}"`);
  }

  const rotateCooldownRemainingMs =
    team.lastRotateAtMs === undefined || state.nowMs === undefined
      ? 0
      : Math.max(0, state.config.rotateCooldownMs - (state.nowMs - team.lastRotateAtMs));

  const vault: VaultProjection = {
    teamId,
    // team.secret / team.shares are already stringified bigints
    // (TeamState / StoredShare, see types.ts) -- VaultProjection uses the
    // exact same wire shape, so no conversion is needed here.
    secret: team.secret,
    shares: team.shares,
    generation: team.generation,
    lastRotateAtMs: team.lastRotateAtMs,
    rotateCooldownRemainingMs,
    rotateMinimumPenalty: disclosureRotateMinimum(state, teamId),
    rotatePenalty: Math.min(team.score, rotationPenalty(state, teamId, state.contracts.filter(c => c.teamId === teamId && c.status === "open" && c.task.kind !== "rps-duel" && c.task.kind !== "ssm-decrypt").length)),
    completedContractIds: team.completedContractIds.map(c => contractId({ tm: teamId, c })),
    huntedGenerations: team.huntedGenerations,
    sudokuSolution: deriveSudokuSolution(state.seed, teamId, team.generation),
    usedPermutations: usedPermutationsFor(state, teamId, team.generation),
    sudokuHuntedGenerations: team.sudokuHuntedGenerations ?? [],
  };

  const publicLedger = decodeLedger(state.publicLedger, state.teams);
  const exposedShareIndices = [...new Set(publicLedger.flatMap((entry) =>
    entry.kind === "share" && entry.teamId === teamId && entry.generation === team.generation
      ? [entry.shareIndex] : [],
  ))];
  const myContracts = state.contracts
    .filter((c) => c.teamId === teamId)
    .map((c) => {
      const task = projectTask(state, teamId, c.task, c.id);
      return {
        id: c.id,
        ...(c.lastSubmissionPoints === undefined ? {} : {lastSubmissionPoints:c.lastSubmissionPoints}),
        ...(state.config.proofProtocol === "schnorr-v1" && c.allowedMethods.includes("prove") ? { schnorr: { y: c.schnorr?.y ?? schnorrStatement(state.seed, teamId, c.id), ...(c.schnorr ? {pending:c.schnorr} : {}) } } : {}),
        kind: c.kind,
        points: c.cipherFailed === true ? 0 : c.points + lightningBonus(state, c),
        ...(c.cipherFailed === undefined ? {} : { cipherFailed: c.cipherFailed }),
        lightningEligible: lightningEligible(state, c),
        leakPoints: c.leakPoints,
        task,
        status: c.status,
        // [Issue #645] The Order's rule and the methods that satisfy it are
        // participant-visible by design: an Order the participant cannot LEAK
        // must say so BEFORE they choose, not by rejecting their submission.
        // Both are public properties of the job, not of anyone's secret.
        privacyConstraint: c.privacyConstraint,
        allowedMethods: c.allowedMethods,
        // `state.nowMs` is only ever undefined before the first `tick()`, and
        // `state.contracts` is only ever non-empty AFTER at least one `tick()`
        // (`initialState` sets `contracts: []`; only `tick()` ever pushes to
        // it) -- so the `?? c.expiresAtMs` fallback (remainingMs 0) is
        // unreachable in practice. It exists only to keep this arithmetic
        // total without an unsafe assertion.
        durationMs: c.expiresAtMs - c.issuedAtMs,
        remainingMs: Math.max(0, c.expiresAtMs - (state.nowMs ?? c.expiresAtMs)),
        hints: projectHints(state, c, task, vault, exposedShareIndices),
        ...(c.expiryCause ? { expiryCause: c.expiryCause } : {}),
      };
    });

  const otherOpenContractCount = state.contracts.filter(
    (c) => c.teamId !== teamId && c.status === "open",
  ).length;

  const teams: Record<string, TeamSummaryProjection> = {};
  // [Issue #696] MY attempts against each OTHER team's current generation.
  // Read through the same `huntKey` `validateOp` charges against, so the
  // number the Portal shows is the number the judge will enforce -- and only
  // the reader's own row of it: `state.huntAttempts` also holds what every
  // other pairing has spent, and none of that is this team's to see.
  const huntAttempts: Record<string, HuntBudgetProjection> = {};
  const sudokuHuntAttempts: Record<string, HuntBudgetProjection> = {};
  for (const other of Object.values(state.teams)) {
    teams[other.teamId] = {
      teamId: other.teamId,
      teamName: other.teamName ?? other.teamId,
      score: other.score,
      generation: other.generation,
      huntedGenerationCount: other.huntedGenerations.length,
    };
    if (other.teamId === teamId) continue;
    huntAttempts[other.teamId] = {
      generation: other.generation,
      spent: huntCount(state, storedHuntKey(state, huntKey(teamId, other.teamId, other.generation))) ?? 0,
      max: state.config.maxHuntAttemptsPerTarget,
    };
    sudokuHuntAttempts[other.teamId] = {
      generation: other.generation,
      spent: huntCount(state, storedHuntKey(state, sudokuHuntKey(teamId, other.teamId, other.generation))) ?? 0,
      max: state.config.maxHuntAttemptsPerTarget,
    };
  }

  // [Issue #677] A waiting match reports its FULL length rather than nothing.
  // The number a player wants before pressing START is "how long am I signing
  // up for", and it is the same field they watch count down afterwards.
  const matchRemainingMs =
    state.startedAtMs === undefined
      ? waitingRemainingMs(state)
      : state.nowMs === undefined
        ? undefined
        : Math.max(0, state.startedAtMs + state.config.matchDurationMs - state.nowMs);

  return {
    ...(state.scoreSteal ? { scoreSteal: projectSteal(state, teamId) } : {}),
    clockMs: state.nowMs,
    ...(team.lastBreach ? { lastBreach: team.lastBreach } : {}),
    ...(state.config.proofProtocol ? {proofProtocol:state.config.proofProtocol} : {}),
    phase: state.phase,
    prime: state.config.prime,
    threshold: state.config.threshold,
    ready: {
      count: (state.readyTeamIds ?? []).length,
      total: Object.keys(state.teams).length,
      me: (state.readyTeamIds ?? []).includes(teamId),
    },
    matchRemainingMs,
    vault,
    myContracts,
    otherOpenContractCount,
    // [Issue #679] `state.publicLedger` is the compact persisted form
    // (`StoredArtifact`, ledger-codec.ts); the projection's own contract
    // (`CryptoBattleProjection.publicLedger: readonly PublicArtifact[]`) is
    // unchanged, so this is the boundary that expands back to it. This makes
    // `projectForTeam` a per-call O(ledger length) allocation where the read
    // side used to be a zero-cost passthrough (5377 entries at 99 teams,
    // worst case) -- an intentional trade against the ~430 KB this shaves off
    // every write's HTTP body (state-size.test.ts), not a free lunch.
    publicLedger,
    teams,
    // Public by construction (see CryptoBattleState.publicPuzzles) -- passed
    // through unredacted, unlike `teams` above it does not need a per-team
    // summary shape. `withMigratedContracts` guarantees it is present.
    publicPuzzles: state.publicPuzzles ?? {},
    rpsHunt: projectRpsHunt(state, teamId),
    huntAttempts,
    sudokuHuntAttempts,
    huntWinPoints: state.config.scores.huntBonus,
    hintBooster: projectBooster(state, teamId),
    lightning: projectLightning(state, teamId),
    publicRsaKeys: state.phase === "endgame" || state.phase === "ended" ? Object.values(state.teams).map(team => {
      const { n, e } = deriveRsaKey(state.seed, team.teamId, team.generation);
      return { teamId: team.teamId, generation: team.generation, n, e };
    }) : [],
    completedHunts: Object.values(state.teams).filter(other => other.teamId !== teamId).flatMap(other =>
      (["share", "sudoku", ...ALL_CIPHER_RUNGS, "rsa", "rotor"] as const).flatMap<NonNullable<CryptoBattleProjection["completedHunts"]>[number]>(via => {
        if (via === "rotor") return hasRotorHunt(state, teamId, other.teamId, other.generation) ? [{ targetTeamId: other.teamId, generation: other.generation, via }] : [];
        const key = via === "share" ? huntKey(teamId, other.teamId, other.generation)
          : via === "sudoku" ? sudokuHuntKey(teamId, other.teamId, other.generation)
          : via === "rsa" ? rsaHuntKey(state, teamId, other.teamId, other.generation)
          : cipherHuntKey(teamId, other.teamId, other.generation, via);
        const logged = (via === "share" || via === "sudoku" || via === "rsa") && hasRecordedHunt(state, teamId, other.teamId, other.generation, via);
        return hasSuccessfulHunt(state, key) || logged ? [{ targetTeamId: other.teamId, generation: other.generation, via }] : [];
      })),
    wrongHuntCost: state.config.scores.wrongHunt,
    wrongProveCost: state.config.scores.wrongProve,
    expiryPenalty: state.config.scores.expiredOrder,
    // [Issue #696] The reader's OWN last HUNT only -- `team` is the row
    // `teamId` resolved to above, never another team's. Spread conditionally
    // so a team that has never HUNTed projects no key at all, which keeps the
    // JSON round trip byte-identical to the object (dev/harness.test.ts
    // compares the two).
    ...(team.lastHunt === undefined ? {} : { lastHunt: readLastHunt(state, team.lastHunt) }),
    ...(team.lastProve === undefined ? {} : { lastProve: team.lastProve }),
    ...(team.lastCipher === undefined ? {} : { lastCipher: team.lastCipher }),
  };
}

function rotationPenalty(state: CryptoBattleState, teamId: string, openCount: number): number {
  return Math.max(disclosureRotateMinimum(state, teamId), openCount * Math.abs(state.config.scores.expiredOrder));
}

/** Domain-separated server randomness; retrying a fixed commitment cannot reroll e. */
function schnorrRandom(seed: string, purpose: string, parts: readonly unknown[]): number {
  for (let counter=0;;counter++) {
    const bytes=createHmac("sha256",seed).update(JSON.stringify(["schnorr-v1",purpose,...parts,counter])).digest();
    for(const byte of bytes) if(byte<253) return byte%11;
  }
}
function applySchnorr(state: CryptoBattleState, teamId: string, op: Extract<CryptoBattleOp,{kind:"schnorr-commit"|"schnorr-response"}>): CryptoBattleState {
  const contract=state.contracts.find(c=>c.id===op.contractId)!;
  if(op.kind==="schnorr-commit") {
    const e=schnorrRandom(state.seed,"challenge",[teamId,contract.id,op.y,op.a]);
    return {...state, contracts:state.contracts.map(c=>c.id===contract.id?{...c,answerAttempted:true,schnorr:{y:op.y,a:op.a,e}}:c)};
  }
  const pending=contract.schnorr!;
  const y=pending.y;
  const outcome = verifySchnorr(y,pending.a,pending.e,op.z) ? "hit" as const : "miss" as const;
  const consumed={...state,contracts:state.contracts.map(c=>c.id===contract.id?{...c,answerAttempted:true,schnorr:{...pending,used:true,outcome}}:c)};
  if(outcome === "miss") {
    // A one-shot miss ends PROVE-only Orders; LEAK remains available when allowed.
    const terminal = contract.allowedMethods.length === 1 && contract.allowedMethods[0] === "prove";
    const contracts = terminal ? consumed.contracts.map(c => c.id === contract.id ? {...c, status:"completed" as const, resolution:"prove" as const} : c) : consumed.contracts;
    return {...consumed, contracts, teams:{...state.teams,[teamId]:{...state.teams[teamId]!,score:Math.max(0,state.teams[teamId]!.score-Math.abs(state.config.scores.wrongProve))}}};
  }
  return completeOrder(consumed,teamId,contract,{
    kind:"proof",id:`${contract.id}-proof`,teamId,generation:state.teams[teamId]!.generation,method:"prove",contractId:contract.id,
    commitment:String(pending.a),challenge:String(pending.e),response:String(op.z),publicKey:String(y),postedAtMs:state.nowMs!,
  },"prove");
}

function schnorrHint(level:number): {ja:string;en:string} {
  const hints=[
    {ja:"秘密の数xをそのまま送らず、今回だけの数rと混ぜた答えzを送ります。答えを確かめる相手を「検証者」と呼びます。先にaを送り、検証者が返した数eを使ってzを計算します。検証者は公開された数とzで式を確かめます。小さい数で計算を体験する模型です。",en:"Instead of sending your secret x, send an answer z that mixes it with a fresh number r. The person checking the answer is the verifier. Send a first, then use the returned number e to calculate z. The verifier checks an equation using public values and z. This is a small-number calculation model."},
    {ja:"式：z = (r + e × x) mod 11。r + e × x を11で割った余りです。\n例：r=3、e=5、x=7\n① 掛ける：5 × 7 = 35\n② 足す：35 + 3 = 38\n③ 11で割る：38 = 11 × 3 + 5\n④ 余りの5をz欄へ入力する。\nこの「割った余り」をmodと書きます。",en:"Formula: z = (r + e × x) mod 11, the remainder of r + e × x divided by 11.\nExample: r=3, e=5, x=7\n① Multiply: 5 × 7 = 35\n② Add: 35 + 3 = 38\n③ Divide by 11: 38 = 11 × 3 + 5\n④ Enter the remainder, 5, in z.\nThis remainder operation is written mod."},
    {ja:"① e × x = □①\n② □① + r = □②\n③ □②を11で割った余り = z\n④ 余りを「計算した余り z」欄に入力して送る。\n今回の数字は「ヒント③：今回の数字で計算」で確認できます。aをまだ送っていなければ、先にそちらの手順でaを送ります。",en:"① e × x = □①\n② □① + r = □②\n③ Remainder of □② divided by 11 = z\n④ Enter the remainder in “Calculated remainder z” and submit.\nSee your values in “Hint 3: calculate with your values”. If you have not sent a yet, follow its steps first."},
  ];
  return hints[level]!;
}

/** Assign the public statement before the prover can choose a commitment.
 * The tiny teaching subgroup permits a browser lookup of x; no practical secrecy. */
function schnorrStatement(seed: string, teamId: string, orderId: string): number {
  const values = [4,8,16,9,18,13,3,6,12];
  for (let counter = 0;; counter++) {
    const bytes = createHmac("sha256", seed).update(JSON.stringify(["schnorr-statement-v1",teamId,orderId,counter])).digest();
    for (const byte of bytes) if (byte < 252) return values[byte % values.length]!;
  }
}

function applyEc(state:CryptoBattleState,teamId:string,op:Extract<CryptoBattleOp,{kind:"ec"}>):CryptoBattleState {
 const c=state.contracts.find(c=>c.id===op.contractId)!;if(c.task.kind!=="ec-add")throw new Error("wrong task");
 const hit=JSON.stringify(parsePoint(op.answer))===JSON.stringify(addPoints(c.task.left,c.task.right));
 const team=state.teams[teamId]!;
 const points=hit?c.points+lightningBonus(state,c):-Math.min(team.score,Math.abs(state.config.scores.wrongProve));
 return {...state,contracts:state.contracts.map(o=>o.id===c.id?{...o,answerAttempted:true,lastSubmissionPoints:points+0,...(hit?{status:"completed" as const,resolution:"ec" as const}:{})}:o),teams:{...state.teams,[teamId]:{...team,score:team.score+points,...(hit?{completedContractIds:[...team.completedContractIds,compactContractId(teamId,c.id)]}:{})}}};
}

function applyIo(state:CryptoBattleState,teamId:string,op:Extract<CryptoBattleOp,{kind:"io"}>):CryptoBattleState {
 const c=state.contracts.find(c=>c.id===op.contractId)!;if(c.task.kind!=="io-equivalence")throw new Error("wrong task");
 const hit=JSON.stringify(parseIoAnswer(op.answer))===JSON.stringify(ioAnswer(c.task));
 const team=state.teams[teamId]!;
 const points=hit?c.points+lightningBonus(state,c):-Math.min(team.score,Math.abs(state.config.scores.wrongProve));
 return {...state,contracts:state.contracts.map(o=>o.id===c.id?{...o,answerAttempted:true,lastSubmissionPoints:points+0,...(hit?{status:"completed" as const,resolution:"io" as const}:{})}:o),teams:{...state.teams,[teamId]:{...team,score:team.score+points,...(hit?{completedContractIds:[...team.completedContractIds,compactContractId(teamId,c.id)]}:{})}}};
}
function applySnark(state: CryptoBattleState, teamId: string, op: Extract<CryptoBattleOp,{kind:"snark"}>): CryptoBattleState {
  const order = state.contracts.find(c => c.id === op.contractId)!;
  if (order.task.kind !== "snark-constraints") throw new Error("wrong task");
  const hit = JSON.stringify(parseResiduals(op.answer)) === JSON.stringify(constraintResiduals(order.task));
  const team = state.teams[teamId]!;
  const points = hit ? order.points + lightningBonus(state,order) : -Math.min(team.score,Math.abs(state.config.scores.wrongProve));
  return {...state,
    contracts: state.contracts.map(c => c.id === order.id ? {...c,answerAttempted:true,lastSubmissionPoints:points+0,...(hit?{status:"completed" as const,resolution:"snark" as const}:{})} : c),
    teams: {...state.teams,[teamId]: {...team,score:team.score+points,...(hit?{completedContractIds:[...team.completedContractIds,compactContractId(teamId,order.id)]}:{})}},
  };
}

function applyStark(state:CryptoBattleState,teamId:string,op:Extract<CryptoBattleOp,{kind:"stark"}>):CryptoBattleState {
 const c=state.contracts.find(c=>c.id===op.contractId)!;if(c.task.kind!=="stark-trace")throw new Error("wrong task");
 const hit=JSON.stringify(parseStarkAnswer(op.answer))===JSON.stringify(starkAnswer(c.task));
 const team=state.teams[teamId]!;
 const points=hit?c.points+lightningBonus(state,c):-Math.min(team.score,Math.abs(state.config.scores.wrongProve));
 return {...state,contracts:state.contracts.map(o=>o.id===c.id?{...o,answerAttempted:true,lastSubmissionPoints:points+0,...(hit?{status:"completed" as const,resolution:"stark" as const}:{})}:o),teams:{...state.teams,[teamId]:{...team,score:team.score+points,...(hit?{completedContractIds:[...team.completedContractIds,compactContractId(teamId,c.id)]}:{})}}};
}

function applyAnamorphic(state:CryptoBattleState,teamId:string,op:Extract<CryptoBattleOp,{kind:"anamorphic"}>):CryptoBattleState {
 const c=state.contracts.find(c=>c.id===op.contractId)!;if(c.task.kind!=="anamorphic-rejection")throw new Error("wrong task");
 const hit=JSON.stringify(parseAnamorphicAnswer(op.answer,c.task))===JSON.stringify(anamorphicAnswer(c.task));
 const team=state.teams[teamId]!;
 const points=hit?c.points+lightningBonus(state,c):-Math.min(team.score,Math.abs(state.config.scores.wrongProve));
 return {...state,contracts:state.contracts.map(o=>o.id===c.id?{...o,answerAttempted:true,lastSubmissionPoints:points+0,...(hit?{status:"completed" as const,resolution:"anamorphic" as const}:{})}:o),teams:{...state.teams,[teamId]:{...team,score:team.score+points,...(hit?{completedContractIds:[...team.completedContractIds,compactContractId(teamId,c.id)]}:{})}}};
}

function applyEvolution(state: CryptoBattleState, teamId: string, op: Extract<CryptoBattleOp,{kind:"evolution"}>): CryptoBattleState {
  const order = state.contracts.find(c => c.id === op.contractId)!;
  if (order.task.kind !== "enigma-encrypt" && order.task.kind !== "ecdsa-sign" && order.task.kind !== "rsa-decrypt") throw new Error("wrong task");
  const hit = JSON.stringify(parseEvolutionAnswer(op.answer)) === JSON.stringify(evolutionAnswer(order.task));
  const team = state.teams[teamId]!;
  const points = hit ? order.points + lightningBonus(state,order) : -Math.min(team.score,Math.abs(state.config.scores.wrongProve));
  return {...state,
    contracts: state.contracts.map(c => c.id === order.id ? {...c,answerAttempted:true,lastSubmissionPoints:points+0,...(hit?{status:"completed" as const,resolution:"evolution" as const}:{})} : c),
    teams: {...state.teams,[teamId]: {...team,score:team.score+points,...(hit?{completedContractIds:[...team.completedContractIds,compactContractId(teamId,order.id)]}:{})}},
  };
}
