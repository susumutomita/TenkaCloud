import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { parseEndpointsHealth } from "../shared/endpoints-health.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

/**
 * 1 teamLoginKey = 1 team (= N deployments) として view を構成する。
 *
 * stackOutputs は DDB に JSON 文字列で入っているが、UI に返す前に object へ展開する。
 * `flagOutputKey` で指定された field は **競技者に出さない** (= 当てる対象なので)。
 */

export interface ParticipantScoringInfo {
  readonly kind: "flag" | "uptime";
  readonly points?: number;
  readonly pointsPerSuccess?: number;
  readonly hints?: readonly string[];
  /** Challenge / flag のとき、提出済みなら true。再提出は加点されない。 */
  readonly flagSubmitted?: boolean;
}

/**
 * チームに紐づく 1 problem 単位の view。team 集約 (`ParticipantTeamView.problems[]`) の
 * 1 要素として返す。
 */
/**
 * Battle 系 (uptime kind) deployment の health 集約。`endpointsHealth` JSON を per-endpoint
 * のまま露出すると「どの endpoint が落ちているか」が見えてしまい Battle のゲーム性
 * (= 防御側が自分で調査) を破壊するため、aggregate のみに絞る (ADR-005 D1)。
 *
 * 旧 deployment / probe 未実行 / Challenge 系 (= flag kind、HealthCheck 対象外) は
 * `unknown` を返す。
 */
export type ApplicationStatusOverall = "healthy" | "degraded" | "down" | "unknown";

export interface ApplicationStatus {
  readonly overall: ApplicationStatusOverall;
  readonly healthyCount: number;
  readonly totalCount: number;
  /** 最後の probe 時刻 (ISO 8601)。`unknown` のときは undefined。 */
  readonly checkedAt?: string;
}

export type ParticipantProblemView = Pick<
  DeploymentItem,
  "jobId" | "problemId" | "region" | "expiresAt" | "awsAccountId"
> & {
  readonly status: DeploymentStatus;
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
  readonly score: number;
  readonly lastScoredAt?: string;
  readonly lastResult?: "ok" | "fail";
  readonly scoring?: ParticipantScoringInfo;
  /**
   * Battle (uptime kind) の集約 health。per-endpoint の URL / 名前は **絶対に出さない**
   * (ADR-005 D1)。Challenge 形式 (flag kind) では undefined。
   */
  readonly applicationStatus?: ApplicationStatus;
  // 設計判断: `endpointsHealth` (= どの endpoint が落ちているか) は participant API には
  // 出さない。Battle のゲーム性は「壊れている原因を防御側自身が調査して復旧する」点に
  // あり、画面で答え合わせをすると興ざめになる。露出するのは aggregate のみ。
  // `awsAccountId` は AWS Console 直接アクセス (SSO Credentials) のため公開する。
  // AWS の account id は機密ではない (= IAM role 信頼ポリシーや CFn template にも露出する)。
};

export interface ParticipantTeamView {
  readonly team: {
    readonly teamName: string;
    readonly teamNameSetByCompetitor: boolean;
    /** Phase 1 以前に作られた deployment は持たない。 */
    readonly eventId?: string;
    readonly teamId?: string;
  };
  readonly problems: readonly ParticipantProblemView[];
}

/**
 * 1 deployment row → ParticipantProblemView 変換。
 *
 * status が DELETING / DELETED の場合は `undefined` を返す。これは sparse 化が
 * 崩れた行 (GSI2PK が残ったまま teardown が進んだケース) への防御。
 *
 * `scoringMap` から該当 problemId の scoring 設定を引き、participant 側に出してよい
 * 情報だけ (= flagOutputKey の値は出さない、kind / points / hints のみ) を含める。
 * stackOutputs からも flagOutputKey フィールドは strip し、答えが見えないようにする。
 */
export function toProblemView(
  item: Partial<DeploymentItem>,
  scoringMap: Record<string, ProblemScoringMetadata> = {},
): ParticipantProblemView | undefined {
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return undefined;

  const stackOutputs = parseStackOutputs(item.stackOutputs);
  const scoring = item.problemId ? scoringMap[item.problemId] : undefined;
  if (scoring?.kind === "flag") {
    delete stackOutputs[scoring.flagOutputKey];
  }

  return {
    jobId: String(item.jobId ?? ""),
    problemId: String(item.problemId ?? ""),
    region: String(item.region ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
    status,
    stackOutputs,
    failureReason: status === "FAILED" ? item.failureReason : undefined,
    expiresAt: Number(item.expiresAt ?? 0),
    score: Number(item.score ?? 0),
    lastScoredAt: typeof item.lastScoredAt === "string" ? item.lastScoredAt : undefined,
    lastResult: item.lastResult,
    scoring: scoring
      ? {
          kind: scoring.kind,
          ...(scoring.kind === "flag"
            ? {
                points: scoring.points,
                hints: scoring.hints,
                flagSubmitted: item.flagSubmitted === true,
              }
            : { pointsPerSuccess: scoring.pointsPerSuccess }),
        }
      : undefined,
    applicationStatus: scoring?.kind === "uptime" ? toApplicationStatus(item) : undefined,
  };
}

/**
 * `endpointsHealth` JSON を aggregate (overall / healthyCount / totalCount / checkedAt)
 * に変換する。**per-endpoint URL / 名前は絶対に出さない** (ADR-005 D1)。
 *
 * 判定ルール:
 *   - probe 未実行 (= endpointsHealth が無い / 空) → `unknown`
 *   - 全 endpoint OK → `healthy`
 *   - 全 endpoint NG → `down`
 *   - 一部 OK → `degraded`
 */
function toApplicationStatus(item: Partial<DeploymentItem>): ApplicationStatus {
  const health = parseEndpointsHealth(item.endpointsHealth);
  const entries = Object.values(health);
  if (entries.length === 0) {
    return { overall: "unknown", healthyCount: 0, totalCount: 0 };
  }
  const healthyCount = entries.filter((e) => e.ok).length;
  const totalCount = entries.length;
  const checkedAt = entries[0]?.checkedAt;
  let overall: ApplicationStatusOverall;
  if (healthyCount === totalCount) overall = "healthy";
  else if (healthyCount === 0) overall = "down";
  else overall = "degraded";
  return checkedAt
    ? { overall, healthyCount, totalCount, checkedAt }
    : { overall, healthyCount, totalCount };
}

/**
 * teamLoginKey で GSI2 を Query して team の全 deployment 行を返し、team 集約 view を作る。
 *
 * - 該当行が無い (key 不正 / GSI2PK 属性が削除された) → undefined (401 相当)
 * - 全行が DELETING / DELETED → undefined (sparse 化が崩れた場合の防御)
 * - 1 つでも live な行があれば team view を返す
 *
 * GSI2 は eventually consistent。直近に rotate / 削除された teamLoginKey は最大
 * 数百ms 程度認証が通る可能性があるが、TTL ベースの teardown と整合する許容範囲。
 */
export async function lookupTeamByLoginKey(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
): Promise<ParticipantTeamView | undefined> {
  const items = await queryTeamItems(shared, teamLoginKey);
  return buildTeamView(items, shared.problemsScoring);
}

/**
 * 既に Query 済みの items から ParticipantTeamView を組み立てる (1 pass)。
 * lookup と update (Update 後の ALL_NEW Attributes 集合) の両方が利用する。
 */
export function buildTeamView(
  items: readonly Partial<DeploymentItem>[],
  scoringMap: Record<string, ProblemScoringMetadata>,
): ParticipantTeamView | undefined {
  if (items.length === 0) return undefined;

  const problems: ParticipantProblemView[] = [];
  let sample: Partial<DeploymentItem> | undefined;
  for (const item of items) {
    const view = toProblemView(item, scoringMap);
    if (view) problems.push(view);
    if (!sample) {
      const status = (item.status ?? "PENDING") as DeploymentStatus;
      if (!DELETED_LIKE_STATUSES.has(status)) sample = item;
    }
  }
  if (!sample || problems.length === 0) return undefined;

  const operatorSlug = String(sample.teamName ?? "");
  const display = typeof sample.displayTeamName === "string" ? sample.displayTeamName : undefined;

  return {
    team: {
      teamName: display ?? operatorSlug,
      teamNameSetByCompetitor: display !== undefined,
      eventId: typeof sample.eventId === "string" ? sample.eventId : undefined,
      teamId: typeof sample.teamId === "string" ? sample.teamId : undefined,
    },
    problems,
  };
}
