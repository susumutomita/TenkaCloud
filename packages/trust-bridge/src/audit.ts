import type { CloudActionIntent } from "./schema.js";
import type { IntentVerifyOutcome } from "./verify.js";

/**
 * Issue #795: audit record helper。
 *
 * allow / deny / needs_approval のすべてを CloudActionAuditRecord として記録する。
 * 失敗系も audit に記録する (= attacker が token を投げ込んで何が起きた
 * かを後から再現可能にする)。
 */

export interface CloudActionAuditRecord {
  readonly requestId: string;
  readonly tenantId: string;
  readonly eventId?: string;
  readonly teamId?: string;
  readonly problemId?: string;
  readonly deploymentId?: string;
  readonly targetId?: string;
  readonly provider: string;
  readonly action: string;
  readonly decision: "allow" | "deny" | "needs_approval";
  readonly denialReason?: string;
  readonly issuedCredentialExpiresAt?: string;
  readonly policyVersion?: string;
  readonly createdAt: string;
}

export interface AuditInput {
  readonly outcome: IntentVerifyOutcome;
  /** verify が成功し policy が allow を返したときの credential 失効時刻 (= AWS の AssumeRole 終了時刻等)。 */
  readonly issuedCredentialExpiresAt?: string;
  readonly policyVersion?: string;
  readonly now?: () => Date;
  /** verify は OK だが上位 policy が deny / needs_approval を返したときの decision 上書き。 */
  readonly overrideDecision?: "deny" | "needs_approval";
  readonly overrideReason?: string;
}

/**
 * 失敗系の intent (= JWS / schema invalid) でも、 token 内の見えた情報から audit を作る。
 * JWS payload は再 decode せず、verify 経路で得た intent または失敗理由だけを使う。
 * fail 系は requestId/tenantId 等が不明なので "unknown" を埋める。
 */
export function buildAuditRecord(input: AuditInput): CloudActionAuditRecord {
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  if (input.outcome.ok) {
    return buildAllowOrOverride(input.outcome.intent, input, createdAt);
  }
  return {
    requestId: "unknown",
    tenantId: "unknown",
    provider: "unknown",
    action: "unknown",
    decision: "deny",
    denialReason: input.outcome.reason,
    createdAt,
  };
}

function buildAllowOrOverride(
  intent: CloudActionIntent,
  input: AuditInput,
  createdAt: string,
): CloudActionAuditRecord {
  const decision: CloudActionAuditRecord["decision"] = input.overrideDecision ?? "allow";
  const record: CloudActionAuditRecord = {
    requestId: intent.requestId,
    tenantId: intent.source.tenantId,
    provider: intent.target.provider,
    action: intent.action.type,
    decision,
    createdAt,
    ...(intent.source.eventId === undefined ? {} : { eventId: intent.source.eventId }),
    ...(intent.source.teamId === undefined ? {} : { teamId: intent.source.teamId }),
    ...(intent.source.problemId === undefined ? {} : { problemId: intent.source.problemId }),
    ...(intent.source.deploymentId === undefined
      ? {}
      : { deploymentId: intent.source.deploymentId }),
    ...(intent.source.targetId === undefined ? {} : { targetId: intent.source.targetId }),
    ...(input.issuedCredentialExpiresAt === undefined
      ? {}
      : { issuedCredentialExpiresAt: input.issuedCredentialExpiresAt }),
    ...(input.policyVersion === undefined ? {} : { policyVersion: input.policyVersion }),
    ...(input.overrideReason === undefined ? {} : { denialReason: input.overrideReason }),
  };
  return record;
}
