export {
  CHALLENGE_PREREQUISITE_GATE_FLAG,
  computeLockedProblemIds,
  isGateCompleted,
  type ProgressionGateConfig,
  ProgressionGateConfigSchema,
  parseProgressionGate,
  resolveTeamGatePolicy,
} from "@tenkacloud/problem-sdk/internal";

import type { DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "./constants.js";

/** `isGateCompleted` に渡す判定対象を選ぶための最小 shape (= deployment 行の部分集合)。 */
export interface GateCompletionRow {
  readonly problemId?: unknown;
  readonly status?: unknown;
  readonly score?: unknown;
  readonly flagSubmitted?: unknown;
  readonly gateCompletedAt?: unknown;
}

/**
 * team の全 deployment 行から 「Gate 完了判定に使う 1 行」 を選ぶ。
 *
 * 行 key は `DEPLOYMENT#<jobId>` 単位なので、 完了した Gate を teardown → 再 deploy すると
 * 完了行は DELETED (系) のまま残り、 再 deploy は別 PK の新規行になる。 このため 2 段で選ぶ:
 *   1. `gateCompletedAt` を持つ行が 1 つでもあれば **それ** を返す (= scoring tick が latch した
 *      one-time 完了 marker。 durable なので Gate deployment を teardown しても完了を保持し、
 *      「完了済 Gate を片付けたら unlock target が再 lock される」 退行を防ぐ)。
 *   2. latch 行が無ければ live 行 (= DELETING/DELETED/EXPIRED/AUTO_DELETED でない) を返す
 *      (= teardown → 再 deploy 直後の未完了 live 行が勝ち、 stale な DELETED 行の raw score には
 *      完了を委ねない)。 該当無しは undefined = 未完了扱い。
 */
export function selectGateCompletionRow<T extends GateCompletionRow>(
  rows: readonly T[],
  gateProblemId: string,
): T | undefined {
  const gateRows = rows.filter((r) => r.problemId === gateProblemId);
  return (
    gateRows.find((r) => typeof r.gateCompletedAt === "string") ??
    gateRows.find((r) => !DELETED_LIKE_STATUSES.has((r.status ?? "PENDING") as DeploymentStatus))
  );
}
