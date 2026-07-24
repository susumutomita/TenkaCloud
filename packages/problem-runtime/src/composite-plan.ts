/**
 * [Composite Runtime / Issues #2062, #2747] Deterministic composite deployment planner.
 *
 * Pure function: a validated descriptor becomes a deeply-frozen DAG plan. Declaration order is
 * retained as the stable tie-breaker, but never implies a dependency. Independent nodes share an
 * execution wave and may run concurrently; dependent nodes receive a later wave.
 */

import {
  type CompositeInputBinding,
  type CompositeOutputDeclaration,
  type CompositeRuntimeDescriptor,
  MAX_COMPOSITE_TARGETS,
  MIN_COMPOSITE_TARGETS,
  RuntimeValidationError,
} from "./index.js";

export const COMPOSITE_PROVIDERS = ["aws", "gcp", "azure", "sakura"] as const;
export type CompositeProvider = (typeof COMPOSITE_PROVIDERS)[number];

export interface CompositeDeploymentPlanTarget {
  readonly targetId: string;
  readonly targetOrdinal: number;
  readonly executionWave: number;
  readonly provider: CompositeProvider;
  readonly engine: string;
  readonly entry: string;
  readonly dependsOn: readonly string[];
  readonly inputs: Readonly<Record<string, CompositeInputBinding>>;
  readonly outputs: Readonly<Record<string, CompositeOutputDeclaration>>;
}

export interface CompositeDeploymentPlan {
  readonly runtimeKind: "composite";
  readonly targets: readonly CompositeDeploymentPlanTarget[];
  /** Target IDs by stable topological wave. */
  readonly waves: readonly (readonly string[])[];
}

function isCompositeProvider(provider: string): provider is CompositeProvider {
  return (COMPOSITE_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Deep-freeze a plan's `inputs` / `outputs` binding record: both callers (below) pass a validated
 * `Record<string, CompositeInputBinding | CompositeOutputDeclaration>`, always an object value, so
 * this only ever needs to freeze the record itself plus a shallow-cloned copy of each entry.
 */
function frozenRecord<T extends object>(
  record: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> {
  const entries = Object.entries(record ?? {}).map(([key, value]) => [
    key,
    Object.freeze({ ...value }),
  ]);
  return Object.freeze(Object.fromEntries(entries));
}

type CompositeRuntimeTargetDescriptor = CompositeRuntimeDescriptor["targets"][number];

/**
 * Returns a memoized `target -> executionWave` resolver rather than a pre-materialized map: every
 * caller already holds the target object it wants the wave for (`buildCompositeDeploymentPlan`'s
 * `targets.map`), so a direct function call is both simpler and keeps the return type `number`
 * (never `number | undefined`) without a dead "missing from the map" fallback.
 */
function computeExecutionWaves(
  targets: readonly CompositeRuntimeTargetDescriptor[],
): (target: CompositeRuntimeTargetDescriptor) => number {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  // Takes the target object itself (never re-looks-up by id): the only caller-side lookup that
  // can fail is a `dependsOn` reference to an id outside `byId`, guarded explicitly below before
  // recursing — so `waveFor` never needs (and cannot hit) an "unknown target" fallback.
  const waveFor = (target: CompositeRuntimeTargetDescriptor): number => {
    const cached = memo.get(target.id);
    if (cached !== undefined) return cached;
    if (visiting.has(target.id)) {
      throw new RuntimeValidationError([
        {
          problemId: "<unknown>",
          path: "runtime.targets",
          message: `dependency cycle includes ${target.id}`,
        },
      ]);
    }
    visiting.add(target.id);
    let wave = 0;
    for (const dependencyId of target.dependsOn ?? []) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new RuntimeValidationError([
          {
            problemId: "<unknown>",
            path: `runtime.targets[${target.id}].dependsOn`,
            message: `unknown dependency ${dependencyId}`,
          },
        ]);
      }
      wave = Math.max(wave, waveFor(dependency) + 1);
    }
    visiting.delete(target.id);
    memo.set(target.id, wave);
    return wave;
  };

  return waveFor;
}

export function buildCompositeDeploymentPlan(
  runtime: CompositeRuntimeDescriptor,
): CompositeDeploymentPlan {
  const { targets } = runtime;
  const issues: { problemId: string; path: string; message: string }[] = [];
  if (targets.length < MIN_COMPOSITE_TARGETS || targets.length > MAX_COMPOSITE_TARGETS) {
    issues.push({
      problemId: "<unknown>",
      path: "runtime.targets",
      message: `composite runtime requires ${MIN_COMPOSITE_TARGETS}..${MAX_COMPOSITE_TARGETS} targets, got ${targets.length}`,
    });
  }

  const seen = new Set<string>();
  targets.forEach((target, index) => {
    const path = `runtime.targets[${index}]`;
    if (!isCompositeProvider(target.provider)) {
      issues.push({
        problemId: "<unknown>",
        path: `${path}.provider`,
        message: `unknown provider ${target.provider}`,
      });
    }
    if (seen.has(target.id)) {
      issues.push({
        problemId: "<unknown>",
        path: `${path}.id`,
        message: `duplicate target id ${target.id}`,
      });
    }
    seen.add(target.id);
  });
  if (issues.length > 0) throw new RuntimeValidationError(issues);

  const executionWaveOf = computeExecutionWaves(targets);
  const planned = targets.map((target, index) =>
    Object.freeze({
      targetId: target.id,
      targetOrdinal: index,
      executionWave: executionWaveOf(target),
      provider: target.provider as CompositeProvider,
      engine: target.engine,
      entry: target.entry,
      dependsOn: Object.freeze([...(target.dependsOn ?? [])]),
      inputs: frozenRecord(target.inputs),
      outputs: frozenRecord(target.outputs),
    }),
  );

  const maximumWave = planned.reduce(
    (maximum, target) => Math.max(maximum, target.executionWave),
    0,
  );
  const waves = Array.from({ length: maximumWave + 1 }, (_, wave) =>
    Object.freeze(
      planned
        .filter((target) => target.executionWave === wave)
        .sort((left, right) => left.targetOrdinal - right.targetOrdinal)
        .map((target) => target.targetId),
    ),
  );

  return Object.freeze({
    runtimeKind: "composite",
    targets: Object.freeze(planned),
    waves: Object.freeze(waves),
  });
}
