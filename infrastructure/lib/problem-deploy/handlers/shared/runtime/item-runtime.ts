import { EXECUTABLE_ENGINE, EXECUTABLE_PROVIDER } from "@tenkacloud/problem-runtime";
import type { ProblemRuntime } from "./adapter.js";

/**
 * [Issue #2571 review-fix] Deployment 行 (DDB item) から {@link ProblemRuntime} を復元する
 * 共有 helper。 `deploy-handler/delete.ts` (単一 teardown) と `event-handler/bulk-delete.ts`
 * (bulk teardown) がそれぞれ同じ 3-field 判定を独立 (ほぼ verbatim コピー) に持っていたため、
 * 1 箇所に集約して drift を防ぐ。
 *
 * `runtimeProvider` / `runtimeEngine` / `runtimeEntry` が 3 つとも揃っていなければ legacy
 * `aws/cloudformation` (entry は deploy 時の既定値 `template.yaml`) にフォールバックする —
 * これは #2571 より前に作られた全 deployment 行 (= runtime field を持たない) と同じ解釈。
 *
 * `generic-scoring-handler/runtime-status-reconciler.ts` の `runtimeFromItem` は似た形をしているが
 * 3 field 欠落時に `undefined` を返す (= 「reconcile 対象外の行」を表す) 点が異なり、legacy AWS 行を
 * 積極的に aws/cloudformation として扱うここの意味論とは違う。 そのため意図的に統合していない。
 */
export interface RuntimeItemFields {
  readonly runtimeProvider?: string;
  readonly runtimeEngine?: string;
  readonly runtimeEntry?: string;
}

export function resolveItemRuntime(item: RuntimeItemFields): ProblemRuntime {
  if (item.runtimeProvider && item.runtimeEngine && item.runtimeEntry) {
    return {
      provider: item.runtimeProvider,
      engine: item.runtimeEngine,
      entry: item.runtimeEntry,
    };
  }
  return { provider: EXECUTABLE_PROVIDER, engine: EXECUTABLE_ENGINE, entry: "template.yaml" };
}
