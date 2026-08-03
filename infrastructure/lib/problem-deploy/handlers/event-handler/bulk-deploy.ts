/**
 * `POST /events/{eventId}/deploy` の orchestrator entry point。
 *
 * Issue #1230: 882 行で planning / persistence / event publish / tracing / validation の責務が
 * 同居していたため、 `bulk-deploy/` 配下に責務単位で sub-module 化した。 本 file は
 * 既存 importer (event-handler/index.ts、 test) との互換性のため re-export だけを担う。
 *
 * 構成:
 *   - `bulk-deploy/orchestrator.ts` — `bulkDeployEvent` 本体 (= 各モジュールを step 単位に呼ぶ)
 *   - `bulk-deploy/targets.ts` — Event / Teams 取得 + teamIds/problemIds filter
 *   - `bulk-deploy/existing-index.ts` — 既存 deployment の index 化 (失敗 / force redeploy 候補)
 *   - `bulk-deploy/verified-accounts.ts` — CompetitorAccounts table を引いた verified 集合
 *   - `bulk-deploy/plan-builder.ts` — N×M plan 生成 (PlanEntry + DeploymentItem + Event Detail)
 *   - `bulk-deploy/persistence.ts` — DDB TransactWrite + Event/Deployment status 更新
 *   - `bulk-deploy/publish.ts` — EventBridge fan-out (旧経路) + Distributed Map 経路 (#910)
 *   - `bulk-deploy/result.ts` — BulkDeployResult builder (unverified の後方互換出力)
 *   - `bulk-deploy/trace.ts` — operator 向けの skip 理由 / enqueue 件数 trace
 *   - `bulk-deploy/types.ts` — 共有 type / 定数 (TRANSACT_WRITE_BATCH / DEFAULT_TTL_MS 等)
 */

export { bulkDeployEvent } from "./bulk-deploy/orchestrator.js";
