import type {
  ArtifactInspector,
  PolicyDecision,
  PolicyEvaluator,
} from "./customer-execution-plane.js";

/**
 * Issue #1727: customer-local な PolicyEvaluator / ArtifactInspector の
 * 再利用可能な実装。 PoC では inline だったものを、 注入できる部品にする。
 *
 * CustomerExecutionPlane は既に audience / account / region / problem allowlist /
 * privilege escalation / TTL を強制するので、 ここでは **その上に重ねる組織ポリシー**
 * (= 予算上限・テンプレ安全性) を提供する。
 */

export interface BudgetPolicyEvaluatorOptions {
  /** intent.constraints.maxEstimatedCostUsd がこの値を超えたら deny。 */
  readonly maxEstimatedCostUsd: number;
  readonly policyVersion?: string;
}

/** 見積コストが local cap を超える intent を deny する PolicyEvaluator。 */
export function createBudgetPolicyEvaluator(
  options: BudgetPolicyEvaluatorOptions,
): PolicyEvaluator {
  const version = options.policyVersion;
  return {
    async evaluate(intent): Promise<PolicyDecision> {
      const cost = intent.constraints.maxEstimatedCostUsd ?? 0;
      if (cost > options.maxEstimatedCostUsd) {
        return {
          decision: "deny",
          reason: `estimated cost ${cost} USD exceeds local cap ${options.maxEstimatedCostUsd} USD`,
          ...(version ? { policyVersion: version } : {}),
        };
      }
      return { decision: "allow", ...(version ? { policyVersion: version } : {}) };
    },
  };
}

/**
 * 複数の PolicyEvaluator を合成する。 fail-closed の優先順位は deny > needs_approval > allow:
 * 最初の deny で即停止し、 deny が無ければ needs_approval があればそれを、 無ければ allow を返す。
 */
export function combinePolicyEvaluators(
  ...evaluators: readonly PolicyEvaluator[]
): PolicyEvaluator {
  return {
    async evaluate(intent): Promise<PolicyDecision> {
      let aggregated: PolicyDecision = { decision: "allow" };
      for (const evaluator of evaluators) {
        const decision = await evaluator.evaluate(intent);
        if (decision.decision === "deny") {
          return decision;
        }
        if (decision.decision === "needs_approval") {
          aggregated = decision;
        }
      }
      return aggregated;
    },
  };
}

export interface ForbiddenTemplatePattern {
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * 既定の禁止パターン: 独立 IAM User / AccessKey の作成、 AdministratorAccess の直付け。
 * いずれも「隔離 challenge アカウントでも避けたい」 high-risk 構成。 caller は差し替え可能。
 */
export const DEFAULT_FORBIDDEN_TEMPLATE_PATTERNS: readonly ForbiddenTemplatePattern[] = [
  { id: "iam-user", pattern: /AWS::IAM::User\b/ },
  { id: "iam-access-key", pattern: /AWS::IAM::AccessKey\b/ },
  { id: "administrator-access", pattern: /AdministratorAccess\b/ },
];

export interface CfnTemplateInspectorOptions {
  readonly forbiddenPatterns?: readonly ForbiddenTemplatePattern[];
}

/**
 * digest 検証済みのテンプレ bytes を走査し、 禁止パターンに当たれば deny する
 * {@link ArtifactInspector}。 当たらなければ allow。
 */
export function createCfnTemplateInspector(
  options: CfnTemplateInspectorOptions = {},
): ArtifactInspector {
  const patterns = options.forbiddenPatterns ?? DEFAULT_FORBIDDEN_TEMPLATE_PATTERNS;
  return {
    async inspect(_intent, bytes) {
      const text = new TextDecoder().decode(bytes);
      for (const { id, pattern } of patterns) {
        if (pattern.test(text)) {
          return { decision: "deny", reason: `template matches forbidden pattern: ${id}` };
        }
      }
      return { decision: "allow" };
    },
  };
}
