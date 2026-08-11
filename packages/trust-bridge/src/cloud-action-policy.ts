import type { CloudActionIntent } from "./schema.js";

/**
 * Issue #2019: staged enforcement of high-risk `CloudActionIntent`.
 *
 * TrustBridge guards the dangerous boundary where the platform AWS account
 * `AssumeRole`s into a participant account and runs CloudFormation. Until now
 * that boundary was observed in **shadow mode** only (`audit.ts` emits a record
 * but never holds the operation). This module is the first step toward
 * *enforcement*: it turns a `CloudActionIntent` plus a customer-local policy
 * into one of three verdicts —
 *
 *   - `"allow"`            — proceed exactly as today (AssumeRole / CFn runs).
 *   - `"needs_approval"`   — HOLD. The caller must NOT acquire authority; an
 *                            operator approves or rejects out of band.
 *   - `"deny"`             — refuse outright (reserved for a future slice; the
 *                            v1 policy shape never emits it, but the verdict type
 *                            keeps the `ALLOW / REQUIRE_APPROVAL / DENY` contract
 *                            from the issue first-class).
 *
 * Design properties (all required by the issue):
 *
 *   1. **Default = shadow/allow.** `enforcementMode: "shadow"` is the default an
 *      operator gets; it always returns `"allow"`, so existing Lite events are
 *      never held. Enforcement is strictly opt-in (`enforcementMode: "enforce"`).
 *   2. **Pure, no I/O.** Every signal the policy needs (is this a bulk op? does
 *      it replace a live stack?) is passed in as `context`. The caller resolves
 *      those facts; this function only decides.
 *   3. **Narrow first cut.** Only the action types + conditions an operator
 *      explicitly lists in `requireApprovalFor` are held. Anything not matched
 *      flows straight through as `"allow"`, so participant-facing normal deploys
 *      are not disrupted — only destructive / cross-cutting operations are gated.
 *
 * The approve / reject store + API + UI are an explicit **follow-on** (out of
 * scope for this slice): here we only derive the verdict and prove that on
 * `"needs_approval"` no authority is acquired.
 */

export type CloudActionEnforcementMode = "shadow" | "enforce";

export type CloudActionVerdict = "allow" | "needs_approval" | "deny";

type ActionType = CloudActionIntent["action"]["type"];

/**
 * Facts about the operation the policy can match on. The caller resolves these
 * (e.g. from the deploy request and a DDB lookup) and passes them in, keeping
 * `evaluateCloudActionRisk` pure. Every field defaults to `false` when omitted,
 * so a caller that knows nothing extra gets the safe "not high-risk" baseline.
 */
export interface CloudActionRiskContext {
  /** Part of a bulk deploy / bulk teardown batch (= many accounts at once). */
  readonly isBulk?: boolean;
  /** A retry of a previously-enqueued operation. */
  readonly isRetry?: boolean;
  /** A force-redeploy that tears down and re-creates an existing deployment. */
  readonly isForceRedeploy?: boolean;
  /** Replaces a stack that is currently live in the participant account. */
  readonly replacesExistingStack?: boolean;
}

/**
 * One "this action type, under these conditions, requires approval" rule.
 *
 * `conditions` is matched as an **AND of the set bits**: every condition the
 * operator pins to `true` must also be `true` in the context for the rule to
 * fire. An empty `conditions` (or one with no `true` flags) matches every
 * intent of `actionType` — i.e. "always hold this action type".
 */
export interface RequireApprovalRule {
  readonly actionType: ActionType;
  readonly conditions?: CloudActionRiskContext;
}

export interface CloudActionPolicy {
  readonly enforcementMode: CloudActionEnforcementMode;
  /** Rules evaluated only when `enforcementMode === "enforce"`. */
  readonly requireApprovalFor?: readonly RequireApprovalRule[];
}

const CONDITION_KEYS: readonly (keyof CloudActionRiskContext)[] = [
  "isBulk",
  "isRetry",
  "isForceRedeploy",
  "replacesExistingStack",
];

/**
 * True when every condition the rule pins to `true` is also `true` in `context`.
 * Conditions left unset (or set to `false`) in the rule are not required, so a
 * rule with no `true` flags matches unconditionally.
 */
function conditionsMatch(
  conditions: CloudActionRiskContext | undefined,
  context: CloudActionRiskContext,
): boolean {
  if (!conditions) {
    return true;
  }
  for (const key of CONDITION_KEYS) {
    if (conditions[key] === true && context[key] !== true) {
      return false;
    }
  }
  return true;
}

function ruleMatches(
  rule: RequireApprovalRule,
  intent: CloudActionIntent,
  context: CloudActionRiskContext,
): boolean {
  return rule.actionType === intent.action.type && conditionsMatch(rule.conditions, context);
}

/**
 * Derive the policy verdict for a `CloudActionIntent`.
 *
 * Pure and gated on `enforcementMode`: in `"shadow"` it always returns `"allow"`
 * (the opt-in safety valve). In `"enforce"` it returns `"needs_approval"` iff
 * some `requireApprovalFor` rule matches the action type *and* its conditions;
 * otherwise `"allow"`.
 */
export function evaluateCloudActionRisk(
  intent: CloudActionIntent,
  policy: CloudActionPolicy,
  context: CloudActionRiskContext = {},
): CloudActionVerdict {
  if (policy.enforcementMode === "shadow") {
    return "allow";
  }
  const rules = policy.requireApprovalFor ?? [];
  for (const rule of rules) {
    if (ruleMatches(rule, intent, context)) {
      return "needs_approval";
    }
  }
  return "allow";
}
