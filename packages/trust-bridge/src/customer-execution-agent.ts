import { buildAuditRecord, type CloudActionAuditRecord } from "./audit.js";
import type { CfnExecutionResult, CloudFormationExecutor } from "./cloudformation-executor.js";
import type {
  CustomerExecutionPlane,
  CustomerExecutionRejected,
  CustomerExecutionRejectionReason,
  CustomerExecutionStage,
} from "./customer-execution-plane.js";
import type { VerifiedCloudActionIntent } from "./schema.js";
import type { IntentVerifyFailureReason } from "./verify.js";

/**
 * Issue #1727: customer execution plane の end-to-end orchestrator。
 *
 * 1 本の `run()` で「署名 intent を検証 → ローカル authority で CFn 実行 → 監査記録」を回す。
 *   - authorize (= CustomerExecutionPlane): authenticity / authorization / artifact 検証
 *   - 成功時のみ CloudFormationExecutor で deploy/destroy (= LOCAL authority)
 *   - 成否どちらでも CloudActionAuditRecord を audit sink に書く
 *
 * 全部品は注入される (= plane / executor / audit)。 trust-bridge は AWS SDK に依存しない。
 */

export type AuditWriter = (record: CloudActionAuditRecord) => Promise<void> | void;

export interface CustomerExecutionAgentOptions {
  readonly plane: CustomerExecutionPlane;
  readonly executor: CloudFormationExecutor;
  readonly audit: AuditWriter;
  readonly now?: () => Date;
}

export interface AgentRunInput {
  readonly token: string;
  readonly artifact: { readonly bytes: Uint8Array };
}

export interface AgentExecuted {
  readonly ok: true;
  readonly intent: VerifiedCloudActionIntent;
  readonly result: CfnExecutionResult;
  readonly audit: CloudActionAuditRecord;
}

export interface AgentRejected {
  readonly ok: false;
  readonly stage: CustomerExecutionStage;
  readonly reason: CustomerExecutionRejectionReason | IntentVerifyFailureReason;
  readonly details?: readonly string[];
  readonly audit: CloudActionAuditRecord;
}

export type AgentRunOutcome = AgentExecuted | AgentRejected;

export class CustomerExecutionAgent {
  private readonly options: CustomerExecutionAgentOptions;
  private readonly now: () => Date;

  constructor(options: CustomerExecutionAgentOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  async run(input: AgentRunInput): Promise<AgentRunOutcome> {
    const outcome = await this.options.plane.authorize({
      token: input.token,
      artifact: input.artifact,
    });

    if (!outcome.ok) {
      const audit = this.denialAudit(outcome);
      await this.options.audit(audit);
      return {
        ok: false,
        stage: outcome.stage,
        reason: outcome.reason,
        ...(outcome.details ? { details: outcome.details } : {}),
        audit,
      };
    }

    // LOCAL authority で実際に CFn を動かす。 artifact は digest 検証済みの bytes。
    const body = new TextDecoder().decode(input.artifact.bytes);
    const result = await this.options.executor.execute(outcome.intent, body);
    const audit = buildAuditRecord({
      outcome: { ok: true, intent: outcome.intent },
      ...(outcome.policyDecision.policyVersion
        ? { policyVersion: outcome.policyDecision.policyVersion }
        : {}),
      now: this.now,
    });
    await this.options.audit(audit);
    return { ok: true, intent: outcome.intent, result, audit };
  }

  private denialAudit(rejected: CustomerExecutionRejected): CloudActionAuditRecord {
    if (rejected.intent) {
      // authentication を通過した拒否: intent の context 付きで deny を記録。
      return buildAuditRecord({
        outcome: { ok: true, intent: rejected.intent },
        overrideDecision: "deny",
        overrideReason: `${rejected.stage}:${rejected.reason}`,
        now: this.now,
      });
    }
    // authenticity 失敗: intent 不明。 verify failure として "unknown" deny を記録。
    return buildAuditRecord({
      outcome: { ok: false, reason: rejected.reason as IntentVerifyFailureReason },
      now: this.now,
    });
  }
}
