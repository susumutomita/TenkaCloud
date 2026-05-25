import type { EventBridgeEvent } from "aws-lambda";
import { writeAuditEvent } from "../../../problem-deploy/handlers/shared/audit-log.js";

/**
 * Issue #1335 Phase 1: Cognito sign-in 成功イベントを CloudTrail / EventBridge から受け取り、
 * `AdminAuditLogTable` の `SYSTEM#<env>` 区画に 1 行書く。
 *
 * ## なぜ Pre-Token Generation trigger ではなく EventBridge / CloudTrail なのか
 * Pre-Token Generation Lambda は UserPool (= ControlPlaneStack 所有) と AdminAuditLogTable
 * (= ProblemDeployBackendStack 所有) の両方を参照する必要があり、 cross-stack ref が双方向
 * になって stack 依存が循環する。 SystemAuditWriter (#1034) と同様に EventBridge listen に
 * することで、 ProblemDeploy → ControlPlane の片方向 ref のまま実装できる (= 既存 invariant
 * の `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME` も維持)。
 *
 * ## 監査属性
 * - action: `auth.sign_in_succeeded` (成功) / `auth.sign_in_denied` (失敗)
 * - tenantId: Control Plane sign-in は SystemAdmin scope なので `"SYSTEM"`
 * - actor: Cognito sub (= responseElements / authParameters から resolve)
 * - actorUsername: email or username (federated は provider prefix 付き)
 * - extra.idp: 解決した IdP 名 (= local は "COGNITO"、 federated は provider name)
 *
 * ## 対象 event 名
 * - `InitiateAuth` / `AdminInitiateAuth`     — 認証開始
 * - `RespondToAuthChallenge`                  — MFA 等の挑戦応答完了で sign-in 確定
 * - `Authenticate`                            — SAML callback
 * - これら以外は skip (= noise)。
 *
 * ## fail-safe
 * writeAuditEvent は env 未配線で no-op、 write 失敗で false。 EventBridge retry storm を
 * 避けるため handler は catch して swallow (= SystemAuditWriter と同方針)。
 */

interface CognitoCloudTrailDetail {
  readonly eventName?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly sourceIPAddress?: string;
  readonly userAgent?: string;
  readonly userIdentity?: {
    readonly type?: string;
    readonly principalId?: string;
    readonly userName?: string;
  };
  readonly requestParameters?: {
    readonly userPoolId?: string;
    readonly clientId?: string;
    readonly authFlow?: string;
    readonly authParameters?: Record<string, string>;
  };
  readonly responseElements?: {
    readonly authenticationResult?: Record<string, unknown>;
    readonly challengeName?: string;
    readonly userSub?: string;
    readonly user?: { readonly Username?: string };
  };
}

const SIGN_IN_EVENT_NAMES = new Set([
  "InitiateAuth",
  "AdminInitiateAuth",
  "RespondToAuthChallenge",
  "AdminRespondToAuthChallenge",
]);

const SYSTEM_TENANT = "SYSTEM";
const COGNITO_LOCAL_IDP = "COGNITO";

export function resolveIdpName(username: string | undefined): string {
  if (!username) return COGNITO_LOCAL_IDP;
  // Cognito federated username 規約: `{providerName}_{subject}`。 local Cognito user は
  // `_` を含まない (email or sub UUID)。
  const underscore = username.indexOf("_");
  if (underscore <= 0) return COGNITO_LOCAL_IDP;
  return username.slice(0, underscore);
}

export interface AuditRow {
  readonly action: "auth.sign_in_succeeded" | "auth.sign_in_denied";
  readonly outcome: "success" | "error";
  readonly actor: string;
  readonly actorUsername?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly idpName: string;
}

export function mapEventToAudit(
  event: EventBridgeEvent<string, CognitoCloudTrailDetail>,
): AuditRow | null {
  const detail = event.detail;
  if (!detail.eventName || !SIGN_IN_EVENT_NAMES.has(detail.eventName)) return null;

  // 成功 / 失敗判定: CloudTrail event は errorCode が無ければ success、 あれば failure。
  // RespondToAuthChallenge では challengeName が次の challenge を返すケースもあり (= MFA
  // 開始でまだ sign-in 完了していない)、 その場合 challengeName が non-empty で
  // authenticationResult が absent → audit としては skip (= 確定 sign-in のみ記録)。
  const isError = !!detail.errorCode;
  const challengeName = detail.responseElements?.challengeName;
  const hasAuthResult = !!detail.responseElements?.authenticationResult;
  if (!isError && challengeName && !hasAuthResult) {
    // MFA 等の中間 challenge は audit に書かない (= 確定 sign-in のみ)。
    return null;
  }

  const userSub = detail.responseElements?.userSub;
  const username =
    detail.responseElements?.user?.Username ??
    detail.requestParameters?.authParameters?.USERNAME ??
    detail.userIdentity?.userName;
  const actor = userSub ?? username ?? "unknown";
  const idpName = resolveIdpName(username);

  return {
    action: isError ? "auth.sign_in_denied" : "auth.sign_in_succeeded",
    outcome: isError ? "error" : "success",
    actor,
    ...(username ? { actorUsername: username } : {}),
    ...(detail.sourceIPAddress ? { ipAddress: detail.sourceIPAddress } : {}),
    ...(detail.userAgent ? { userAgent: detail.userAgent } : {}),
    idpName,
  };
}

export async function handler(
  event: EventBridgeEvent<string, CognitoCloudTrailDetail>,
): Promise<void> {
  const row = mapEventToAudit(event);
  if (!row) {
    return;
  }
  const occurredAtMs = event.time ? new Date(event.time).getTime() : Date.now();
  try {
    await writeAuditEvent({
      tenantId: SYSTEM_TENANT,
      actor: row.actor,
      ...(row.actorUsername ? { actorUsername: row.actorUsername } : {}),
      action: row.action,
      outcome: row.outcome,
      ...(row.ipAddress ? { ipAddress: row.ipAddress } : {}),
      ...(row.userAgent ? { userAgent: row.userAgent } : {}),
      occurredAtMs,
      extra: { idp: row.idpName },
    });
  } catch (err) {
    // EventBridge retry storm を避けるため throw しない (= SystemAuditWriter と同方針)。
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[control-plane/sign-in-audit] write failed (swallowed)", {
      action: row.action,
      message,
    });
  }
}
