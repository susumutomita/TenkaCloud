import { timingSafeEqual } from "node:crypto";
import {
  type ProblemDisruptionEntry,
  type ProblemEndpointSlot,
  type ProblemPhaseEntry,
  type ProblemScoringMetadata,
  parseDisruptionEntry,
  parseEndpointSlot,
  parsePhaseEntry,
  parseScoringMetadata,
} from "@tenkacloud/problem-sdk/internal";
import { StatusCodes } from "http-status-codes";
import { runAttackDetectionKind } from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/kinds/attack-detection";
import {
  type CompositeTargetProvider,
  scoreCompositeProbe,
} from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/kinds/composite-probe";
import { runPhasedPollingKind } from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/kinds/phased-polling";
import { runUptimeFlatKind } from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/kinds/uptime-flat";
import { runUptimeMultiKind } from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/kinds/uptime-multi";
import type {
  AttackProbeFn,
  AttackProbeRequest,
  AuthoritativeEndpointPlacement,
  DeploymentScoringState,
  KindResult,
  ProbeFn,
  ProbeOptions,
  ProbeResult,
} from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/scoring-kernel";
import { parseLoopbackUrl } from "./loopback";
import type { SimulatedCloudProblem } from "./simulator";

const MAX_PROBE_BODY_BYTES = 4_096;
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

export type SimulatorDeploymentScoringState = DeploymentScoringState;
type SimulatorSupportedScoringMetadata = Exclude<
  ProblemScoringMetadata,
  { readonly kind: "multi-flag" | "multi-verify" }
>;

export interface SimulatorScoringContract {
  readonly scoring: SimulatorSupportedScoringMetadata;
  readonly endpoints: readonly ProblemEndpointSlot[];
  readonly phases: readonly ProblemPhaseEntry[];
  readonly disruptions: readonly ProblemDisruptionEntry[];
}

export interface SimulatorScoreCycleInput {
  readonly problem: SimulatedCloudProblem;
  readonly outputs: Readonly<Record<string, string>>;
  readonly overrides: ReadonlyMap<string, string>;
  readonly score: number;
  readonly createdAt: string;
  readonly lastResult?: "ok" | "fail";
  readonly endpointsHealth?: string;
  readonly scoringState: DeploymentScoringState;
  readonly nowMs: number;
  /** Authenticated Simulator provider operation used only for scorer attack probes. */
  readonly attackProbe?: AttackProbeFn;
  readonly authoritativeEndpointPlacements?: readonly AuthoritativeEndpointPlacement[];
}

function parseList<T>(
  value: unknown,
  field: string,
  parse: (item: unknown) => T | undefined,
): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => {
    const parsed = parse(item);
    if (!parsed) throw new Error(`${field}[${index}] is invalid`);
    return parsed;
  });
}

export function simulatorScoringContract(problem: SimulatedCloudProblem): SimulatorScoringContract {
  const scoring = parseScoringMetadata(problem.metadata.scoring);
  if (!scoring) throw new Error(`${problem.problemId}.scoring is invalid or unsupported`);
  if (scoring.kind === "multi-flag" || scoring.kind === "multi-verify") {
    throw new Error(`Simulator local play does not support scoring kind ${scoring.kind}`);
  }
  return {
    scoring,
    endpoints: parseList(
      problem.metadata.endpoints,
      `${problem.problemId}.endpoints`,
      parseEndpointSlot,
    ),
    phases: parseList(problem.metadata.phases, `${problem.problemId}.phases`, parsePhaseEntry),
    disruptions: parseList(
      problem.metadata.disruptions,
      `${problem.problemId}.disruptions`,
      parseDisruptionEntry,
    ),
  };
}

function candidateOutputKeys(
  outputs: Readonly<Record<string, string>>,
  outputKey: string,
): readonly string[] {
  return Object.keys(outputs).filter((key) => key === outputKey || key.endsWith(`.${outputKey}`));
}

export function simulatorOutput(
  outputs: Readonly<Record<string, string>>,
  outputKey: string,
  targetId?: string,
): string | undefined {
  if (targetId === "default") return outputs[outputKey];
  if (targetId) return outputs[`${targetId}.${outputKey}`];
  const keys = candidateOutputKeys(outputs, outputKey);
  if (keys.length > 1) {
    throw new Error(`Simulator output ${outputKey} is ambiguous across targets`);
  }
  return keys.length === 1 ? outputs[keys[0]] : undefined;
}

/** Reserve every namespaced Simulator* segment for runtime control material. */
export function isParticipantSimulatorOutputKey(key: string): boolean {
  return key.split(".").every((segment) => !segment.startsWith("Simulator"));
}

const SIMULATOR_AWS_PUBLIC_HOSTS = [
  /(^|\.)amazonaws\.com$/,
  /(^|\.)on\.aws$/,
  /(^|\.)console\.aws\.amazon\.com$/,
] as const;

/**
 * Simulator provider URLs are synthetic control/data-plane identifiers. The
 * routable data-plane variants are replaced with loopback URLs before this
 * boundary; anything still pointing at an AWS-owned host would only send the
 * participant away from the local world (for example an AWS Console deep link).
 */
function isUnroutableSimulatorAwsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return SIMULATOR_AWS_PUBLIC_HOSTS.some((pattern) => pattern.test(url.hostname));
}

export function participantSimulatorOutputs(
  problem: SimulatedCloudProblem,
  outputs: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const { scoring } = simulatorScoringContract(problem);
  const hidden = new Set<string>();
  if (scoring.kind === "flag") hidden.add(scoring.flagOutputKey);
  if (scoring.kind === "multi-flag") {
    for (const flag of scoring.flags) hidden.add(flag.flagOutputKey);
  }
  return Object.fromEntries(
    Object.entries(outputs).filter(
      ([key, value]) =>
        isParticipantSimulatorOutputKey(key) &&
        ![...hidden].some((outputKey) => key === outputKey || key.endsWith(`.${outputKey}`)) &&
        !isUnroutableSimulatorAwsUrl(value),
    ),
  );
}

export function simulatorFlagMatches(
  problem: SimulatedCloudProblem,
  outputs: Readonly<Record<string, string>>,
  submitted: string,
): boolean {
  const { scoring } = simulatorScoringContract(problem);
  if (scoring.kind !== "flag") throw new Error(`${problem.problemId} does not use flag scoring`);
  const expected = simulatorOutput(outputs, scoring.flagOutputKey);
  if (expected === undefined)
    throw new Error(`Simulator output is missing ${scoring.flagOutputKey}`);
  const expectedBytes = Buffer.from(expected);
  const submittedBytes = Buffer.from(submitted);
  return (
    expectedBytes.byteLength === submittedBytes.byteLength &&
    timingSafeEqual(expectedBytes, submittedBytes)
  );
}

async function cappedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, MAX_PROBE_BODY_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_PROBE_BODY_BYTES) {
    const next = await reader.read();
    if (next.done) break;
    const remaining = MAX_PROBE_BODY_BYTES - total;
    const value = next.value.subarray(0, remaining);
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel();
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Real HTTP probe restricted to a Simulator-owned loopback workload boundary. */
export const probeSimulatorUrl: ProbeFn = async (
  value: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> => {
  let url: URL;
  try {
    url = parseLoopbackUrl(value, "Simulator workload URL");
  } catch {
    return { ok: false, status: undefined, responseTimeMs: 0 };
  }
  if (url.username || url.password) return { ok: false, status: undefined, responseTimeMs: 0 };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      redirect: "manual",
      signal: controller.signal,
      ...(options.method === "POST" && options.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: options.body }
        : {}),
    });
    const responseTimeMs = Date.now() - startedAt;
    const ok = options.expectStatus
      ? options.expectStatus.includes(response.status)
      : response.status >= StatusCodes.OK && response.status < StatusCodes.MULTIPLE_CHOICES;
    return {
      ok,
      status: response.status,
      responseTimeMs,
      ...(options.readBody && ok ? { body: await cappedBody(response) } : {}),
    };
  } catch {
    return { ok: false, status: undefined, responseTimeMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
  }
};

function namespacedTargetOutputs(
  outputs: Readonly<Record<string, string>>,
  targetId: string,
): Readonly<Record<string, string>> {
  const prefix = `${targetId}.`;
  return Object.fromEntries(
    Object.entries(outputs)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  );
}

function compositeTargetProvider(provider: string): CompositeTargetProvider {
  switch (provider) {
    case "aws":
    case "gcp":
    case "azure":
    case "sakura":
      return provider;
    default:
      throw new Error(`composite-probe does not support provider ${provider}`);
  }
}

async function compositeCycle(
  input: SimulatorScoreCycleInput,
  scoring: Extract<ProblemScoringMetadata, { readonly kind: "composite-probe" }>,
): Promise<KindResult> {
  if (!("kind" in input.problem.runtime)) {
    throw new Error("composite-probe scoring requires a composite runtime");
  }
  const result = await scoreCompositeProbe(
    {
      parentDeploymentId: input.problem.problemId,
      parentStatus: "COMPLETE",
      targets: input.problem.runtime.targets.map((target) => ({
        targetId: target.id,
        provider: compositeTargetProvider(target.provider),
        status: "COMPLETE",
        outputs: namespacedTargetOutputs(input.outputs, target.id),
      })),
    },
    scoring,
    async (url, options) => {
      const outcome = await probeSimulatorUrl(url, options);
      return { ok: outcome.ok };
    },
  );
  const nowIso = new Date(input.nowMs).toISOString();
  return {
    scoreDelta: result.pointsAwarded,
    scoreEvents:
      result.pointsAwarded > 0
        ? [{ source: "uptime", points: result.pointsAwarded, occurredAt: nowIso }]
        : [],
    lastResult: result.success ? "ok" : "fail",
  };
}

/** Run the existing generic scoring kind against Simulator outputs and real loopback probes. */
export async function runSimulatorScoreCycle(input: SimulatorScoreCycleInput): Promise<KindResult> {
  const contract = simulatorScoringContract(input.problem);
  if (contract.scoring.kind === "flag") {
    return { scoreDelta: 0, scoreEvents: [] };
  }
  if (contract.scoring.kind === "composite-probe") {
    return compositeCycle(input, contract.scoring);
  }
  const nowIso = new Date(input.nowMs).toISOString();
  const genericInput = {
    deployment: {
      problemId: input.problem.problemId,
      stackOutputs: JSON.stringify(input.outputs),
      createdAt: input.createdAt,
      score: input.score,
      ...(input.lastResult ? { lastResult: input.lastResult } : {}),
      ...(input.endpointsHealth ? { endpointsHealth: input.endpointsHealth } : {}),
    },
    scoring: contract.scoring,
    slots: contract.endpoints,
    overrides: [...input.overrides].map(([slot, overrideUrl]) => ({ slot, overrideUrl })),
    phases: contract.phases,
    nowMs: input.nowMs,
    nowIso,
    prevState: input.scoringState,
    probe: probeSimulatorUrl,
    ...(input.attackProbe ? { attackProbe: input.attackProbe } : {}),
    ...(input.authoritativeEndpointPlacements
      ? { authoritativeEndpointPlacements: input.authoritativeEndpointPlacements }
      : {}),
  };
  if (contract.scoring.kind === "uptime" || contract.scoring.kind === "uptime-flat") {
    return runUptimeFlatKind({ ...genericInput, scoring: contract.scoring });
  }
  if (contract.scoring.kind === "uptime-multi") {
    return runUptimeMultiKind({ ...genericInput, scoring: contract.scoring });
  }
  if (contract.scoring.kind === "phased-polling") {
    // Fail closed: loopback /meta is participant-controlled and cannot prove a
    // managed provider tier. Use the production hostname verifier unchanged.
    return runPhasedPollingKind({ ...genericInput, scoring: contract.scoring });
  }
  return runAttackDetectionKind({ ...genericInput, scoring: contract.scoring });
}

export interface SimulatorDisruptionCommand {
  readonly provider: string;
  readonly operation: string;
  readonly targetId: string;
  readonly engine: string;
  readonly service: string;
  readonly resourceType: string;
  readonly input: Readonly<Record<string, unknown>>;
}

interface SimulatorHttpAttackProbeInput {
  readonly slot?: string;
  readonly path?: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly probe?: string;
}

function primaryRuntime(problem: SimulatedCloudProblem) {
  if (!("kind" in problem.runtime)) {
    return { targetId: "default", ...problem.runtime };
  }
  const aws = problem.runtime.targets.find((target) => target.provider === "aws");
  if (!aws) throw new Error("Disruption action requires a provider target");
  return { targetId: aws.id, provider: aws.provider, engine: aws.engine, entry: aws.entry };
}

/** Build the generic provider command used by both scoring and operator attack probes. */
export function simulatorAttackProbeCommand(
  problem: SimulatedCloudProblem,
  input: SimulatorHttpAttackProbeInput,
): SimulatorDisruptionCommand {
  const target = primaryRuntime(problem);
  return {
    provider: target.provider,
    operation: "AttackProbe",
    targetId: target.targetId,
    engine: target.engine,
    service: "http",
    resourceType: "HTTP::Endpoint",
    input: {
      TargetId: target.targetId,
      ...(input.slot ? { Slot: input.slot } : {}),
      ...(input.path ? { Path: input.path } : {}),
      ...(input.method ? { Method: input.method } : {}),
      ...(input.body !== undefined ? { Body: input.body } : {}),
      ...(input.probe ? { Probe: input.probe } : {}),
    },
  };
}

export function simulatorScoringAttackProbeCommand(
  problem: SimulatedCloudProblem,
  request: AttackProbeRequest,
): SimulatorDisruptionCommand {
  return simulatorAttackProbeCommand(problem, request);
}

function simulatorOperatorProbeCommand(
  problem: SimulatedCloudProblem,
  disruption: ProblemDisruptionEntry,
): SimulatorDisruptionCommand {
  const probe = disruption.parameters?.probe;
  if (typeof probe !== "string" || probe.length === 0) {
    throw new Error(`Disruption ${disruption.id} has no provider action or HTTP probe`);
  }
  const slot = disruption.parameters?.slot;
  const path = disruption.parameters?.path;
  const method = disruption.parameters?.method;
  const body = disruption.parameters?.body;
  return simulatorAttackProbeCommand(problem, {
    probe,
    ...(typeof slot === "string" && slot.length > 0 ? { slot } : {}),
    ...(typeof path === "string" && path.length > 0 ? { path } : {}),
    ...(method === "GET" || method === "POST" ? { method } : {}),
    ...(typeof body === "string" ? { body } : {}),
  });
}

function simulatorProviderActionCommand(
  problem: SimulatedCloudProblem,
  outputs: Readonly<Record<string, string>>,
  disruptionId: string,
  action: NonNullable<ProblemDisruptionEntry["action"]>,
): SimulatorDisruptionCommand {
  const target = primaryRuntime(problem);
  const targetResource = simulatorOutput(outputs, action.targetRef, target.targetId);
  if (!targetResource) {
    throw new Error(`Disruption ${disruptionId} is missing output ${action.targetRef}`);
  }
  const input = {
    targetRef: action.targetRef,
    targetResource,
    ...(action.documentName ? { documentName: action.documentName } : {}),
    ...(action.functionRef ? { functionRef: action.functionRef } : {}),
    parameters: action.paramTemplate ?? {},
    revert: action.revert,
  };
  const command = {
    "ssm-run-command": {
      operation: "SendCommand",
      service: "ssm",
      resourceType: "AWS::SSM::Command",
    },
    "lambda-invoke": {
      operation: "Invoke",
      service: "lambda",
      resourceType: "AWS::Lambda::Function",
    },
    "cfn-stack-update": {
      operation: "UpdateStack",
      service: "cloudformation",
      resourceType: "AWS::CloudFormation::Stack",
    },
  }[action.kind];
  return {
    provider: target.provider,
    operation: command.operation,
    targetId: target.targetId,
    engine: target.engine,
    service: command.service,
    resourceType: command.resourceType,
    input,
  };
}

export function simulatorDisruptionCommand(
  problem: SimulatedCloudProblem,
  outputs: Readonly<Record<string, string>>,
  disruptionId: string,
): SimulatorDisruptionCommand {
  const disruption = simulatorScoringContract(problem).disruptions.find(
    (candidate) => candidate.id === disruptionId,
  );
  if (!disruption) throw new Error(`Unknown Simulator disruption: ${disruptionId}`);
  if (!disruption.action) return simulatorOperatorProbeCommand(problem, disruption);
  return simulatorProviderActionCommand(problem, outputs, disruptionId, disruption.action);
}
