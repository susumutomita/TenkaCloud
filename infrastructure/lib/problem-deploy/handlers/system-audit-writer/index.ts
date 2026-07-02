import type { EventBridgeEvent } from "aws-lambda";
import { writeAuditEvent } from "../shared/audit-log.js";
import { isSbtOnboardingDetailType, type SbtOnboardingDetailType } from "./sbt-detail-types.js";

/**
 * Issue #1034: SBT Control Plane が発する tenant onboarding / offboarding events を audit
 * (= `PK=SYSTEM#<env>`) に集約する EventBridge listener。
 *
 * 旧状態: SystemAdmin による tenant 作成 / 削除は SBT 経由なので、 App Plane Lambda の
 * `writeAuditEvent` は呼ばれず、 `audit-log` page の SystemAdmin scope は常に 0 件だった
 * (= 「監査ログがありません」 表示)。 本 handler が SBT EventBridge bus を listen し、
 * onboarding* / offboarding* の 6 detailType を SYSTEM scope audit に書き戻す。
 *
 * actor:
 *   SBT event の detail に Cognito identity が乗っていれば優先 (= `sub` / `cognitoUsername`)。
 *   無ければ "sbt-control-plane" を識別子に置く (= 「SBT 経由の自動 / 不明 actor」 として
 *   区別可能)。
 *
 * fail-safe:
 *   writeAuditEvent は env 未配線で no-op、 書込失敗で false を返す。 lambda が error を
 *   throw すると EventBridge が再 deliver を試みるため、 catch して swallow (= audit 行 1 件
 *   欠落より event bus の retry storm を避ける)。
 */

interface SbtTenantEventDetail {
  readonly tenantId?: string;
  readonly tenantName?: string;
  readonly tier?: string;
  /** SBT が actor を載せている場合の path 候補。 環境次第で位置が違うので複数 fallback。 */
  readonly sub?: string;
  readonly cognitoUsername?: string;
  readonly username?: string;
  readonly actor?: string;
}

// Issue #2201: キー集合を `Record<SbtOnboardingDetailType, ...>` で型固定する。 共有定数
// (sbt-detail-types.ts) と 1 キーでもずれると型エラーになり、 Rule フィルタとの整合が
// コンパイル時に保証される。
const SBT_DETAIL_TYPE_TO_ACTION: Readonly<
  Record<SbtOnboardingDetailType, { action: string; outcome: string }>
> = {
  onboardingRequest: { action: "tenant_create_requested", outcome: "success" },
  onboardingSuccess: { action: "tenant_create_succeeded", outcome: "success" },
  onboardingFailure: { action: "tenant_create_failed", outcome: "error" },
  offboardingRequest: { action: "tenant_delete_requested", outcome: "success" },
  offboardingSuccess: { action: "tenant_delete_succeeded", outcome: "success" },
  offboardingFailure: { action: "tenant_delete_failed", outcome: "error" },
};

export type SbtTenantEventDetailType = SbtOnboardingDetailType;

const FALLBACK_ACTOR = "sbt-control-plane";

/**
 * Issue #1029: CodeBuild の Build State Change event (= AWS default bus 経由) を別 actor で
 * 区別する。 SBT pipeline の Step Functions が CodeBuild FAILED を SUCCEEDED で報告する
 * silent failure に対する観測性 fix として、 FAILED build を audit log に記録する。
 */
const CODEBUILD_DETAIL_TYPE = "CodeBuild Build State Change";
const CODEBUILD_ACTOR = "codebuild";

export function resolveActor(detail: SbtTenantEventDetail): {
  actor: string;
  actorUsername?: string;
} {
  const actor = detail.sub ?? detail.actor ?? FALLBACK_ACTOR;
  const actorUsername = detail.cognitoUsername ?? detail.username;
  return actorUsername ? { actor, actorUsername } : { actor };
}

interface CodeBuildStateChangeDetail {
  readonly "build-status"?: string;
  readonly "project-name"?: string;
  readonly "build-id"?: string;
  readonly region?: string;
}

export interface MappedAuditRow {
  readonly tenantId: string;
  readonly action: string;
  readonly outcome: "success" | "error";
  readonly target: string | undefined;
  readonly actor: string;
  readonly actorUsername: string | undefined;
  readonly occurredAtMs: number;
  readonly extra: Record<string, string>;
}

export function mapEventToAudit(
  event: EventBridgeEvent<string, SbtTenantEventDetail | CodeBuildStateChangeDetail>,
): MappedAuditRow | null {
  // Issue #1029: CodeBuild Build State Change で build-status=FAILED のものを audit に記録する。
  if (event["detail-type"] === CODEBUILD_DETAIL_TYPE) {
    return mapCodeBuildEvent(event as EventBridgeEvent<string, CodeBuildStateChangeDetail>);
  }
  const tenantDetail = event.detail as SbtTenantEventDetail;
  const detailType = event["detail-type"];
  if (!isSbtOnboardingDetailType(detailType)) return null;
  const mapping = SBT_DETAIL_TYPE_TO_ACTION[detailType];
  const { actor, actorUsername } = resolveActor(tenantDetail);
  const occurredAtMs = event.time ? new Date(event.time).getTime() : Date.now();
  const extra: Record<string, string> = {};
  if (tenantDetail.tier) extra.tier = tenantDetail.tier;
  if (tenantDetail.tenantName) extra.tenantName = tenantDetail.tenantName;
  return {
    tenantId: "SYSTEM",
    action: mapping.action,
    outcome: mapping.outcome === "error" ? "error" : "success",
    target: tenantDetail.tenantId,
    actor,
    actorUsername,
    occurredAtMs,
    extra,
  };
}

/**
 * Issue #1029: CodeBuild Build State Change event の FAILED / FAULT / STOPPED / TIMED_OUT を
 * audit に書く。 SUCCEEDED は noise が多いので skip (= 1 deploy で 1 件出ても観測価値が薄い)。
 * SBT pipeline + 本 stack の DeployCodeBuild の両 project が catch される (= 副次的に問題 deploy
 * の失敗も audit に上がる、 silent failure の網羅性が上がる)。
 */
function mapCodeBuildEvent(
  event: EventBridgeEvent<string, CodeBuildStateChangeDetail>,
): MappedAuditRow | null {
  const buildStatus = event.detail["build-status"];
  if (!buildStatus || buildStatus === "SUCCEEDED" || buildStatus === "IN_PROGRESS") {
    return null;
  }
  const occurredAtMs = event.time ? new Date(event.time).getTime() : Date.now();
  const extra: Record<string, string> = { buildStatus };
  if (event.detail["build-id"]) extra.buildId = event.detail["build-id"];
  if (event.detail.region) extra.region = event.detail.region;
  return {
    tenantId: "SYSTEM",
    action: "codebuild_failed",
    outcome: "error",
    target: event.detail["project-name"],
    actor: CODEBUILD_ACTOR,
    actorUsername: undefined,
    occurredAtMs,
    extra,
  };
}

export async function handler(
  event: EventBridgeEvent<string, SbtTenantEventDetail | CodeBuildStateChangeDetail>,
): Promise<void> {
  const row = mapEventToAudit(event);
  if (!row) {
    console.warn("[system-audit-writer] unknown / non-audit-worthy event, skipping", {
      detailType: event["detail-type"],
    });
    return;
  }
  try {
    await writeAuditEvent({
      tenantId: row.tenantId,
      actor: row.actor,
      ...(row.actorUsername ? { actorUsername: row.actorUsername } : {}),
      action: row.action,
      outcome: row.outcome,
      ...(row.target ? { target: row.target } : {}),
      occurredAtMs: row.occurredAtMs,
      ...(Object.keys(row.extra).length > 0 ? { extra: row.extra } : {}),
    });
  } catch (err) {
    // EventBridge retry storm を避けるため throw しない (= [[feedback-question-premise-before-patching]]
    // の fail-safe pattern と同方針、 writeAuditEvent 自体も内部で fail-safe だが念のため二重防御)。
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[system-audit-writer] write failed (swallowed)", {
      detailType: event["detail-type"],
      message,
    });
  }
}
