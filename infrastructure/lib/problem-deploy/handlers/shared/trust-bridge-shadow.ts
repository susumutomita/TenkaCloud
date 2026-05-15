import {
  buildAuditRecord,
  type CloudActionIntent,
  INTENT_VERSION,
  parseCloudActionIntent,
} from "@TenkaCloud/trust-bridge";
import { logDeployTrace, warnDeployTrace } from "./trace-log.js";

/**
 * Issue #795 ADR-017 Phase 3 (shadow integration): deploy / destroy 経路で
 * `CloudActionIntent` を 1 件構築し、 audit record を CloudWatch に emit する。
 *
 * 本 module は **shadow integration** (= 既存 deploy flow には触れず、 並行で
 * 観測可能な audit を残す):
 *
 *   - 既存の publishProblemEvent + STS AssumeRole 経路は変更しない
 *   - 失敗系も fail-open (= intent 構築 / parse / audit のいずれが落ちても
 *     deploy 本体に影響を与えない)
 *   - 出る log だけが Phase 3 の観測価値 (= ADR-017 D5 audit record の早期 wire)
 *
 * 将来 Phase 5+ で intent verify → AwsAssumeRoleExchange の実 integration に
 * 切り替えるとき、 本 shadow path がベースラインの「intent shape が正しく組める」
 * 保証として機能する (= shape drift を CloudWatch で観測できる)。
 */

export interface ShadowIntentParams {
  readonly jobId: string;
  readonly tenantId: string;
  readonly teamSlug?: string;
  readonly problemId: string;
  readonly namePrefix: string;
  readonly region: string;
  readonly awsAccountId: string;
  readonly competitorRoleArn?: string;
  readonly nowMs: number;
  readonly ttlSeconds: number;
  readonly action: "deploy" | "destroy";
  readonly requestedScopes: readonly string[];
}

/**
 * 観測のみが目的なので throw しない。 失敗系も `warnDeployTrace` に reason を残す。
 */
export function emitShadowAudit(params: ShadowIntentParams): void {
  let intent: CloudActionIntent;
  try {
    intent = buildIntentFromParams(params);
  } catch (err) {
    warnDeployTrace("trust-bridge.shadow.intent-build-failed", {
      jobId: params.jobId,
      correlationId: params.jobId,
      action: params.action,
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const parsed = parseCloudActionIntent(intent);
  if (!parsed.ok) {
    // schema 違反は ADR-017 D1 「explicit failure」 原則に対する観測点。 deploy 本体
    // は失敗させない (= shadow なので) が、 audit record で deny を残す。
    warnDeployTrace("trust-bridge.shadow.schema-invalid", {
      jobId: params.jobId,
      correlationId: params.jobId,
      action: params.action,
      issues: parsed.issues.join("; "),
    });
    const record = buildAuditRecord({
      outcome: { ok: false, reason: "schema-invalid", details: parsed.issues },
      now: () => new Date(params.nowMs),
    });
    logDeployTrace("trust-bridge.shadow.audit", {
      jobId: params.jobId,
      correlationId: params.jobId,
      decision: record.decision,
      denialReason: record.denialReason,
      tenantId: record.tenantId,
      provider: record.provider,
      action: record.action,
      createdAt: record.createdAt,
    });
    return;
  }

  // shadow path では「verify が成功した」 想定の audit を出す。 実 verify は
  // Phase 5+ で AwsAssumeRoleExchange と合わせて wire する。
  const record = buildAuditRecord({
    outcome: {
      ok: true,
      // brand を bypass する shadow 用キャスト。 実 verify path では verifyIntent
      // が返す brand を使う。
      intent: parsed.intent as CloudActionIntent & { readonly __verified: true },
    },
    now: () => new Date(params.nowMs),
  });
  logDeployTrace("trust-bridge.shadow.audit", {
    jobId: params.jobId,
    correlationId: params.jobId,
    decision: record.decision,
    tenantId: record.tenantId,
    eventId: record.eventId,
    teamId: record.teamId,
    problemId: record.problemId,
    deploymentId: record.deploymentId,
    provider: record.provider,
    action: record.action,
    createdAt: record.createdAt,
  });
}

function buildIntentFromParams(params: ShadowIntentParams): CloudActionIntent {
  const expiresAt = new Date(params.nowMs + params.ttlSeconds * 1000).toISOString();
  return {
    version: INTENT_VERSION,
    requestId: params.jobId,
    // shadow 期は nonce 単独 store を持たないため jobId を再利用 (= ULID は実用上
    // unique)。 実 verify 期に DDB-backed nonce store と組み合わせる。
    nonce: params.jobId,
    source: {
      system: "tenkacloud",
      tenantId: params.tenantId,
      ...(params.teamSlug ? { teamId: params.teamSlug } : {}),
      problemId: params.problemId,
      deploymentId: params.jobId,
      // workloadId は Lambda function ARN を持ち込むのが理想。 shadow では env から
      // 取得できない場合があるので固定 stub。
      workloadId: "tenkacloud-problem-deploy-handler",
    },
    target: {
      provider: "aws",
      providerAccountRef: params.awsAccountId,
      region: params.region,
      ...(params.competitorRoleArn ? { resourceScope: params.competitorRoleArn } : {}),
    },
    action: {
      type: params.action,
      engine: "cloudformation",
      entry: params.namePrefix,
      requestedScopes: params.requestedScopes,
    },
    constraints: {
      ttlSeconds: params.ttlSeconds,
      expiresAt,
      allowPrivilegeEscalation: false,
    },
  };
}
