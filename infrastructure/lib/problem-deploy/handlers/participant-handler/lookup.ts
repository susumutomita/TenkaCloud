import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
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
export type ParticipantProblemView = Pick<
  DeploymentItem,
  "jobId" | "problemId" | "region" | "expiresAt"
> & {
  readonly status: DeploymentStatus;
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
  readonly score: number;
  readonly lastScoredAt?: string;
  readonly lastResult?: "ok" | "fail";
  readonly scoring?: ParticipantScoringInfo;
  // 設計判断: `endpointsHealth` (= どの endpoint が落ちているか) は participant API には
  // 出さない。Battle のゲーム性は「壊れている原因を防御側自身が調査して復旧する」点に
  // あり、画面で答え合わせをすると興ざめになる。
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
  };
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
