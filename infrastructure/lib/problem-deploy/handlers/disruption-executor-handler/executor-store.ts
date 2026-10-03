/**
 * [Issue #1419] executor の DDB 副作用 dep 実装 (`executeDisruptionAction` の
 * `claimExecution` / `resolveDeployment` の具体実装)。 既存 pattern を踏襲し新 SDK 依存を増やさない:
 *   - claim: disruption-fire の REQUEST# 冪等 claim と同型 (conditional Put + CCF=duplicate)
 *   - resolve: leaderboard-score-events の GSI1(TENANT#)+eventId filter query と同型
 *
 * AssumeRole / SDK 送信 / scheduler は別 dep (= deploy 判断を伴うため owner)。 ここは DDB のみ。
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeploymentsQueryPort } from "../../control-data/deployments-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import type { DeploymentTarget, DisruptionFiredDetail } from "./execute.js";
import { resolveDeploymentsRepository, resolveDisruptionsRepository } from "./shared.js";

export interface ExecutorResources {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  /** Deployments テーブル (= deploy-handler が書く row)。 GSI1 = TENANT#。 */
  readonly deploymentsTableName: string;
  /** Disruptions テーブル (= fire の REQUEST#/AUDIT# と同居、 EXEC# 冪等行を置く)。 */
  readonly disruptionsTableName: string;
  /** EXEC# 行の TTL 秒数 (省略時 7 日)。 */
  readonly execTtlSeconds?: number;
}

const DEFAULT_EXEC_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `EXEC#{requestId}#{teamId}` を conditional Put で奪う。 at-least-once 配送に対する per-team 冪等性。
 * ConditionalCheckFailed = 既に処理済 (duplicate)、 それ以外の error は伝播。
 *
 * phase で claim key を分ける:
 *   - `"event"` (既定): fired event (EventBridge at-least-once) の重複を弾く。
 *   - `"inject"`: scheduled fire の遅延注入 (aws-scheduler at-least-once) の重複を弾く。 遅延注入は
 *     fired event とは別の配送経路なので、 別 key で claim しないと scheduler 再配送で二重注入になる。
 */
export async function claimExecution(
  resources: ExecutorResources,
  detail: DisruptionFiredDetail,
  nowMs: number,
  phase: "event" | "inject" | "recurring" = "event",
): Promise<"claimed" | "duplicate"> {
  // [Issue #2442 / Phase C3] DDB アクセス (conditional PutItem) は repository seam に移設。
  // `phase` ごとの物理 key 導出は repository の責務 (= 他 aggregate と同じ「物理キーは caller に
  // 見せない」規約)。 outcome は A2 union 契約 (`claimed`/`already`) を this 関数の既存公開契約
  // (`"claimed" | "duplicate"`) に畳む — route.ts / execute.ts の呼び出し側は無変更。
  const repository = await resolveDisruptionsRepository(resources);
  const outcome = await repository.claimExecutionSlot({
    requestId: detail.requestId,
    teamId: detail.teamId,
    phase,
    disruptionId: detail.disruptionId,
    eventId: detail.eventId,
    problemId: detail.problemId,
    tenantId: detail.tenantId,
    firedAt: detail.firedAt,
    expiresAt: Math.floor(nowMs / 1000) + (resources.execTtlSeconds ?? DEFAULT_EXEC_TTL_SECONDS),
  });
  return outcome.outcome === "claimed" ? "claimed" : "duplicate";
}

/**
 * fired `(tenantId, eventId, teamId, problemId)` の **COMPLETE** deployment を GSI1 query で解決する。
 * 未 deploy / 未完了は undefined (= 注入対象なし、 caller が no-op にする)。
 *
 * #1710: competitorRoleArn / externalIdParameterName は **必須にしない**。 SaaS (cross-account) では
 * 両方揃うが、 Lite mode (= same-account deploy) では両方とも未設定で、 その場合 executor は AssumeRole
 * せず Lambda 自身の credentials で同一アカウントへ注入する (= `assumeCompetitorRole` が双方 absent で
 * undefined creds を返す既存 same-account 経路)。 両者を必須にしていたため Lite では常に undefined →
 * 障害が silently no-op していた。
 */
export async function resolveDeployment(
  resources: ExecutorResources,
  detail: DisruptionFiredDetail,
): Promise<DeploymentTarget | undefined> {
  // #1815: 全ページ drain。GSI1(TENANT#)+filter は対象行が後続ページに居ると missed になり、
  // resolveDeployment が undefined を返して disruption が silent no-op する (= この関数が
  // 直そうとした不具合そのものの再来)。
  const repository: DeploymentsQueryPort = await resolveDeploymentsRepository(resources);
  const items = (await repository.listByEventTeamProblem(
    detail.tenantId,
    detail.eventId,
    detail.teamId,
    detail.problemId,
  )) as Partial<DeploymentItem>[];
  // #1710: cross-account 情報 (competitorRoleArn / externalIdParameterName) は要求しない。
  // 同一アカウント (Lite) deploy では両者とも欠落するのが正常。
  const ready = items.find(
    (d) => d.status === "COMPLETE" && typeof d.jobId === "string" && typeof d.region === "string",
  );
  if (!ready) return undefined;
  // #1710: cross-account fields は both-or-neither で扱う (= assumeCompetitorRole と同契約)。
  // deploy-handler は competitorRoleArn を行に永続化するが externalIdParameterName は
  // event detail にしか載せない (deploy.ts:177 vs 259-261) ため、 実際の行は role 有・externalId 無
  // の非対称になる。 片方だけを target に載せると assumeCompetitorRole が
  // "must be provided together" で throw する。 両者揃ったときだけ cross-account injection、
  // それ以外は same-account injection (executor 自身の credentials) 扱いにする。
  const crossAccount =
    typeof ready.competitorRoleArn === "string" &&
    typeof ready.externalIdParameterName === "string";
  return {
    jobId: ready.jobId as string,
    region: ready.region as string,
    ...(crossAccount
      ? {
          competitorRoleArn: ready.competitorRoleArn as string,
          externalIdParameterName: ready.externalIdParameterName as string,
        }
      : {}),
    stackOutputs: parseStackOutputs(ready.stackOutputs),
  };
}
