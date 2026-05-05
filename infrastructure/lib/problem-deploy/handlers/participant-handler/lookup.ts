import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import type { ParticipantSharedResources } from "./shared.js";

/**
 * 競技者向け sanitized view。`DeploymentItem` から chosen フィールドのみを `Pick`
 * で派生させることで、`DeploymentItem` に新規フィールドが増えたときに「明示的に
 * include する / 除外する」判断を強制する (operator 内部情報の意図せぬ漏洩を防ぐ)。
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

export type ParticipantView = Pick<
  DeploymentItem,
  "jobId" | "problemId" | "region" | "expiresAt"
> & {
  readonly teamName: string;
  readonly teamNameSetByCompetitor: boolean;
  readonly status: DeploymentStatus;
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
  readonly score: number;
  readonly lastScoredAt?: string;
  readonly lastResult?: "ok" | "fail";
  readonly scoring?: ParticipantScoringInfo;
};

const DELETED_LIKE_STATUSES: ReadonlySet<DeploymentStatus> = new Set(["DELETING", "DELETED"]);

interface FlagScoringConfig {
  kind: "flag";
  flagOutputKey: string;
  points: number;
  hints?: string[];
}
interface UptimeScoringConfig {
  kind: "uptime";
  pointsPerSuccess: number;
}
type AnyScoringConfig = FlagScoringConfig | UptimeScoringConfig | undefined;

function asScoringConfig(value: unknown): AnyScoringConfig {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { kind?: unknown };
  if (v.kind === "flag") {
    const f = value as { flagOutputKey?: unknown; points?: unknown; hints?: unknown };
    if (typeof f.flagOutputKey === "string" && typeof f.points === "number") {
      return {
        kind: "flag",
        flagOutputKey: f.flagOutputKey,
        points: f.points,
        hints: Array.isArray(f.hints)
          ? (f.hints.filter((h) => typeof h === "string") as string[])
          : undefined,
      };
    }
  }
  if (v.kind === "uptime") {
    const u = value as { pointsPerSuccess?: unknown };
    if (typeof u.pointsPerSuccess === "number") {
      return { kind: "uptime", pointsPerSuccess: u.pointsPerSuccess };
    }
  }
  return undefined;
}

/**
 * DDB の生 row → `ParticipantView` 変換。`lookupByTeamLoginKey` と
 * `setDisplayTeamName` (UpdateCommand `ReturnValues=ALL_NEW`) の両方から呼ばれる。
 *
 * status が DELETING / DELETED の場合は `undefined` を返す。これは sparse 化が
 * 崩れた行 (GSI2PK が残ったまま teardown が進んだケース) への防御。
 *
 * `scoringMap` から該当 problemId の scoring 設定を引き、participant 側に出してよい
 * 情報だけ (= flagOutputKey の値は出さない、kind / points / hints のみ) を含める。
 * stackOutputs からも flagOutputKey フィールドは strip し、答えが見えないようにする。
 */
export function toView(
  item: Partial<DeploymentItem>,
  scoringMap: Record<string, unknown> = {},
): ParticipantView | undefined {
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return undefined;
  const operatorTeamSlug = String(item.teamName ?? "");
  const display = typeof item.displayTeamName === "string" ? item.displayTeamName : undefined;

  const stackOutputs = parseStackOutputs(item.stackOutputs);
  const scoring = item.problemId ? asScoringConfig(scoringMap[item.problemId]) : undefined;
  if (scoring?.kind === "flag") {
    delete stackOutputs[scoring.flagOutputKey];
  }

  return {
    jobId: String(item.jobId ?? ""),
    problemId: String(item.problemId ?? ""),
    teamName: display ?? operatorTeamSlug,
    teamNameSetByCompetitor: display !== undefined,
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
 * teamLoginKey で GSI2 を Query して 1 件の deployment を返す。
 *
 * GSI2 は eventually consistent。直近に rotate / 削除された teamLoginKey は
 * 最大数百ms 程度認証が通る可能性があるが、TTL ベースの teardown を 1 分間隔で
 * 回す運用 (PR-E StatusUpdater) と整合する許容範囲。
 *
 * - 該当行が無い (key 不正 / GSI2PK 属性が削除された) → undefined (401 相当)
 * - status が DELETING / DELETED → undefined (sparse 化が崩れた場合の防御)
 */
export async function lookupByTeamLoginKey(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
): Promise<ParticipantView | undefined> {
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": `TEAMKEY#${teamLoginKey}` },
      Limit: 1,
    }),
  );
  const item = (out.Items?.[0] ?? undefined) as Partial<DeploymentItem> | undefined;
  if (!item) return undefined;
  return toView(item, shared.problemsScoring);
}
