import type { EventBridgeEvent } from "aws-lambda";
import { writeAuditEvent } from "../shared/audit-log.js";

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

const SBT_DETAIL_TYPE_TO_ACTION: Readonly<Record<string, { action: string; outcome: string }>> = {
  onboardingRequest: { action: "tenant_create_requested", outcome: "success" },
  onboardingSuccess: { action: "tenant_create_succeeded", outcome: "success" },
  onboardingFailure: { action: "tenant_create_failed", outcome: "error" },
  offboardingRequest: { action: "tenant_delete_requested", outcome: "success" },
  offboardingSuccess: { action: "tenant_delete_succeeded", outcome: "success" },
  offboardingFailure: { action: "tenant_delete_failed", outcome: "error" },
};

export type SbtTenantEventDetailType = keyof typeof SBT_DETAIL_TYPE_TO_ACTION;

const FALLBACK_ACTOR = "sbt-control-plane";

export function resolveActor(detail: SbtTenantEventDetail): {
  actor: string;
  actorUsername?: string;
} {
  const actor = detail.sub ?? detail.actor ?? FALLBACK_ACTOR;
  const actorUsername = detail.cognitoUsername ?? detail.username;
  return actorUsername ? { actor, actorUsername } : { actor };
}

export function mapEventToAudit(event: EventBridgeEvent<string, SbtTenantEventDetail>): {
  tenantId: string;
  action: string;
  outcome: "success" | "error";
  target: string | undefined;
  actor: string;
  actorUsername: string | undefined;
  occurredAtMs: number;
  extra: Record<string, string>;
} | null {
  const mapping = SBT_DETAIL_TYPE_TO_ACTION[event["detail-type"]];
  if (!mapping) return null;
  const { actor, actorUsername } = resolveActor(event.detail);
  const occurredAtMs = event.time ? new Date(event.time).getTime() : Date.now();
  const extra: Record<string, string> = {};
  if (event.detail.tier) extra.tier = event.detail.tier;
  if (event.detail.tenantName) extra.tenantName = event.detail.tenantName;
  return {
    tenantId: "SYSTEM",
    action: mapping.action,
    outcome: mapping.outcome === "error" ? "error" : "success",
    target: event.detail.tenantId,
    actor,
    actorUsername,
    occurredAtMs,
    extra,
  };
}

export async function handler(
  event: EventBridgeEvent<string, SbtTenantEventDetail>,
): Promise<void> {
  const row = mapEventToAudit(event);
  if (!row) {
    console.warn("[system-audit-writer] unknown detail-type, skipping", {
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
