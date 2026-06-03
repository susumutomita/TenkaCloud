/**
 * [Issue #1667] DynamoDB capacity model for a TenkaCloud event under the 1 RCU / 1 WCU
 * `DynamoDbLowCapacity` pin (= Free Tier 25/25). Answers the non-functional question the
 * platform never measured: **how many teams before the hot Deployments table throttles?**
 *
 * This is a logic-level model (no real load test against AWS), which is the verification the
 * owner accepts. The scoring-loop load is **exact** — derived from `generic-scoring-handler`:
 * every `rate(1 minute)` tick Scans each COMPLETE deployment (1 read) and, per scored
 * deployment, writes the score (`UpdateItem`) + a score-event row (`PutItem`) = 2 writes. The
 * participant read load is **parameterized** (documented assumption) because it flows through
 * the portal API; tune `deploymentsReadsPerPoll` to match a traced value.
 *
 * DDB capacity units: 1 WCU = one write of ≤1 KB per second; 1 RCU = one strongly-consistent
 * read of ≤4 KB per second (= two eventually-consistent reads). Deployment items here are well
 * under those sizes, so 1 write ≈ 1 WCU and 1 eventually-consistent read ≈ 0.5 RCU.
 */

export interface CapacityInputs {
  readonly teams: number;
  readonly problemsPerTeam: number;
  readonly participantsPerTeam: number;
  /** scoring Lambda の起動間隔 (= EventBridge `rate(1 minute)` = 60s)。 */
  readonly scoringTickSeconds: number;
  /** participant portal の poll 間隔 (= 30s、 実 cadence)。 */
  readonly participantPollSeconds: number;
  /** poll 1 回で participant が Deployments table から読む problem あたり item 数 (documented 推定、 既定 1)。 */
  readonly deploymentsReadsPerPoll: number;
}

/** 実 cadence + 控えめな read 推定。 `teams` だけ caller が与える。 */
export const DEFAULT_CAPACITY_INPUTS: Omit<CapacityInputs, "teams"> = {
  problemsPerTeam: 3,
  participantsPerTeam: 2,
  scoringTickSeconds: 60,
  participantPollSeconds: 30,
  deploymentsReadsPerPoll: 1,
};

export interface DeploymentsTableLoad {
  readonly teams: number;
  readonly deployments: number;
  readonly scoringScanReadsPerSec: number;
  readonly scoringWritesPerSec: number;
  readonly participantReadsPerSec: number;
  readonly totalReadsPerSec: number;
  readonly totalWritesPerSec: number;
  /** eventually-consistent 換算 RCU。 */
  readonly readCapacityUnits: number;
  readonly writeCapacityUnits: number;
  readonly readThrottles: boolean;
  readonly writeThrottles: boolean;
}

/** `DynamoDbLowCapacity` aspect が全 table に強制する provisioned 値。 */
export const PROVISIONED_RCU = 1;
export const PROVISIONED_WCU = 1;
/** 採点 tick が 1 deployment あたり Deployments table に出す write 数 (score UpdateItem + score-event PutItem)。 */
export const SCORING_WRITES_PER_DEPLOYMENT = 2;

/** Deployments table (= 最も hot) の sustained 負荷を K teams で算出する。 */
export function modelDeploymentsTable(inputs: CapacityInputs): DeploymentsTableLoad {
  const deployments = inputs.teams * inputs.problemsPerTeam;
  const participants = inputs.teams * inputs.participantsPerTeam;

  const scoringScanReadsPerSec = deployments / inputs.scoringTickSeconds;
  const scoringWritesPerSec =
    (deployments * SCORING_WRITES_PER_DEPLOYMENT) / inputs.scoringTickSeconds;
  const participantReadsPerSec =
    (participants * inputs.deploymentsReadsPerPoll * inputs.problemsPerTeam) /
    inputs.participantPollSeconds;

  const totalReadsPerSec = scoringScanReadsPerSec + participantReadsPerSec;
  const totalWritesPerSec = scoringWritesPerSec;
  const readCapacityUnits = totalReadsPerSec / 2; // eventually-consistent
  const writeCapacityUnits = totalWritesPerSec; // ≤1 KB items

  return {
    teams: inputs.teams,
    deployments,
    scoringScanReadsPerSec,
    scoringWritesPerSec,
    participantReadsPerSec,
    totalReadsPerSec,
    totalWritesPerSec,
    readCapacityUnits,
    writeCapacityUnits,
    readThrottles: readCapacityUnits > PROVISIONED_RCU,
    writeThrottles: writeCapacityUnits > PROVISIONED_WCU,
  };
}

export interface ThrottlePoint {
  /** 1/1 を超えない最大 team 数。 */
  readonly maxTeams: number;
  /** 最初に超える軸 (= 設備増強の対象)。 `none` は探索上限まで余裕あり。 */
  readonly limiting: "read" | "write" | "none";
}

/** Deployments table が 1 RCU / 1 WCU を最初に超える直前の team 数を求める。 */
export function maxTeamsBeforeThrottle(
  base: Omit<CapacityInputs, "teams">,
  searchLimit = 10_000,
): ThrottlePoint {
  for (let teams = 1; teams <= searchLimit; teams++) {
    const load = modelDeploymentsTable({ ...base, teams });
    if (load.writeThrottles || load.readThrottles) {
      return { maxTeams: teams - 1, limiting: load.readThrottles ? "read" : "write" };
    }
  }
  return { maxTeams: searchLimit, limiting: "none" };
}
