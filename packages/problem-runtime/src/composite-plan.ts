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

function frozenRecord<T>(record: Readonly<Record<string, T>> | undefined): Readonly<Record<string, T>> {
  const entries = Object.entries(record ?? {}).map(([key, value]) => [
    key,
    typeof value === "object" && value !== null ? Object.freeze({ ...value }) : value,
  ]);
  return Object.freeze(Object.fromEntries(entries));
}

function computeExecutionWaves(
  targets: readonly CompositeRuntimeDescriptor["targets"][number][],
): ReadonlyMap<string, number> {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const waveFor = (targetId: string): number => {
    const cached = memo.get(targetId);
    if (cached !== undefined) return cached;
    if (visiting.has(targetId)) {
      throw new RuntimeValidationError([
        {
          problemId: "<unknown>",
          path: "runtime.targets",
          message: `dependency cycle includes ${targetId}`,
        },
      ]);
    }
    visiting.add(targetId);
    const target = byId.get(targetId);
    if (!target) {
      throw new RuntimeValidationError([
        {
          problemId: "<unknown>",
          path: "runtime.targets",
          message: `unknown target ${targetId}`,
        },
      ]);
    }
    let wave = 0;
    for (const dependency of target.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new RuntimeValidationError([
          {
            problemId: "<unknown>",
            path: `runtime.targets[${targetId}].dependsOn`,
            message: `unknown dependency ${dependency}`,
          },
        ]);
      }
      wave = Math.max(wave, waveFor(dependency) + 1);
    }
    visiting.delete(targetId);
    memo.set(targetId, wave);
    return wave;
  };

  for (const target of targets) waveFor(target.id);
  return memo;
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

  const wavesByTarget = computeExecutionWaves(targets);
  const planned = targets.map((target, index) =>
    Object.freeze({
      targetId: target.id,
      targetOrdinal: index,
      executionWave: wavesByTarget.get(target.id) ?? 0,
      provider: target.provider as CompositeProvider,
      engine: target.engine,
      entry: target.entry,
      dependsOn: Object.freeze([...(target.dependsOn ?? [])]),
      inputs: frozenRecord(target.inputs),
      outputs: frozenRecord(target.outputs),
    }),
  );

  const maximumWave = planned.reduce((maximum, target) => Math.max(maximum, target.executionWave), 0);
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
