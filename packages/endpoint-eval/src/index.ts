/**
 * @tenkacloud/endpoint-eval — Issue #1973
 *
 * ターゲット非依存の外部エンドポイント評価エンジン。 engine (host) と challenge (plugin) を
 * 分離し、 SSRF ガード・段階 probe・署名付き一回限りクリアコードを提供する。 `app.fetch` は
 * ローカル (Bun.serve) でもクラウド (hono/aws-lambda) でも同一に動く。
 */
export { createEvalApp, type EvalAppDeps } from "./app.js";
export {
  type ChallengeDefinition,
  type PublicStageInfo,
  publicStages,
} from "./challenge.js";
export { CHALLENGES, cloudflareApiSecurity001 } from "./challenges/index.js";
export {
  type ClearCodeClaims,
  type ClearCodeVerifyResult,
  issueClearCode,
  verifyClearCode,
} from "./clear-code.js";
export { createLocalEvalApp, type LocalEvalOptions } from "./local.js";
export {
  applyTemplate,
  type Probe,
  type ProbeContext,
  type ProbeExpectation,
  type ProbeOutcome,
  type ProbeRequest,
  runProbe,
} from "./probe.js";
export {
  type EvaluationRecord,
  type EvaluationStatus,
  InMemoryRunRepository,
  type RunRecord,
  type RunRepository,
} from "./run-store.js";
export { seededValue } from "./run-values.js";
export { evaluateStage, type StageDefinition, type StageResult } from "./stage.js";
export {
  CLOUDFLARE_WORKERS_POLICY,
  type GuardResult,
  guardTargetUrl,
  LOCAL_CONTAINER_POLICY,
  type TargetPolicy,
  widenForLocal,
} from "./target-guard.js";
