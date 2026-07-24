/**
 * Issue #2758: 「どのファイルが high-risk か」の正本 (registry)。
 *
 * jscpd ratchet (check-duplication.ts) と同じ形の Phase 1 施策 —
 * 「100% を要求する gate」ではなく「今の値からの回帰だけを検出する ratchet」。
 * infrastructure 全体はまだ #1424 の 100% gate 対象外 (report-only) だが、 AssumeRole /
 * ExternalId / tenant isolation / deploy state machine / scoring / delete lifecycle /
 * auth boundary は壊れると競技者アカウントへの越境や不正スコアリングに直結するため、
 * 「この一覧のファイルだけ」coverage の後退を機械的に検出する。
 *
 * 一覧に載せるのは `bun run scripts/quality/check-infra-critical-coverage.ts` が
 * 起動時に repo root からの `existsSync` で存在確認する。 rename でこっそり検査対象から
 * 消えることを防ぐため、 存在しないエントリは loud に fail する (silent drop 禁止)。
 */

export type CriticalPathCategory =
  | "assume-role-external-id"
  | "tenant-isolation"
  | "deploy-state-machine"
  | "scoring"
  | "delete-lifecycle"
  | "auth-boundary";

export interface CriticalPathEntry {
  /** repo-root 相対パス (常に `infrastructure/` 配下)。 */
  readonly path: string;
  readonly category: CriticalPathCategory;
}

export const INFRA_CRITICAL_PATHS: readonly CriticalPathEntry[] = [
  // --- AssumeRole / ExternalId: 競技者アカウントへの越境の生命線 ---
  {
    path: "infrastructure/lib/problem-deploy/handlers/shared/assume-competitor-role.ts",
    category: "assume-role-external-id",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/shared/external-id-store.ts",
    category: "assume-role-external-id",
  },
  {
    path: "infrastructure/lib/problem-deploy/external-id-audit-lambda.ts",
    category: "assume-role-external-id",
  },

  // --- Tenant isolation: テナント境界を跨ぐ入口となる各 handler の index.ts ---
  {
    path: "infrastructure/lib/problem-deploy/handlers/event-handler/index.ts",
    category: "tenant-isolation",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/deploy-handler/index.ts",
    category: "tenant-isolation",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/describe-stack-handler/index.ts",
    category: "tenant-isolation",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/competitor-accounts-handler/index.ts",
    category: "tenant-isolation",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/system-audit-writer/index.ts",
    category: "tenant-isolation",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/index.ts",
    category: "tenant-isolation",
  },

  // --- Deploy state machine: CFn CreateStack へ至る dispatch 経路 ---
  {
    path: "infrastructure/lib/problem-deploy/deploy-create-state-machine.ts",
    category: "deploy-state-machine",
  },
  {
    path: "infrastructure/lib/problem-deploy/deploy-delete-state-machine.ts",
    category: "deploy-state-machine",
  },
  {
    path: "infrastructure/lib/problem-deploy/bulk-deploy-create-state-machine.ts",
    category: "deploy-state-machine",
  },
  {
    path: "infrastructure/lib/problem-deploy/state-machine-helpers.ts",
    category: "deploy-state-machine",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/deploy-handler/deploy.ts",
    category: "deploy-state-machine",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/deploy-handler/composite-deploy.ts",
    category: "deploy-state-machine",
  },

  // --- Scoring: 不正スコアリングは競技の公正性を直接壊す ---
  {
    path: "infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/scoring-kernel.ts",
    category: "scoring",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/scoring-active.ts",
    category: "scoring",
  },
  {
    path: "infrastructure/lib/problem-deploy/generic-scoring-lambda.ts",
    category: "scoring",
  },
  {
    path: "infrastructure/lib/problem-deploy/control-data/dynamodb-deployments-scoring.ts",
    category: "scoring",
  },
  {
    path: "infrastructure/lib/problem-deploy/control-data/sql-deployments-scoring.ts",
    category: "scoring",
  },

  // --- Delete lifecycle: 削除漏れ/二重実行は競技者アカウント上にリソースを残す ---
  {
    path: "infrastructure/lib/problem-deploy/handlers/deploy-handler/delete.ts",
    category: "delete-lifecycle",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/cfn-deploy-handler/delete-stack.ts",
    category: "delete-lifecycle",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/event-handler/bulk-delete.ts",
    category: "delete-lifecycle",
  },

  // --- Auth boundary: JWT 検証が壊れるとテナント/参加者/管理者の境界が崩れる ---
  {
    path: "infrastructure/lib/problem-deploy/handlers/shared/auth-wiring.ts",
    category: "auth-boundary",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/deploy-handler/auth.ts",
    category: "auth-boundary",
  },
  {
    path: "infrastructure/lib/problem-deploy/handlers/participant-handler/auth.ts",
    category: "auth-boundary",
  },
  {
    path: "infrastructure/lib/admin-insight/handlers/admin-insight-handler/auth.ts",
    category: "auth-boundary",
  },
  {
    path: "infrastructure/lib/control-plane/handlers/idp-handler/auth.ts",
    category: "auth-boundary",
  },
] as const;
