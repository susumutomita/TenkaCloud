import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  isCompositeRuntime,
  isContainerRuntime,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
  type SingleRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
import { z } from "zod";
import { compareCodePoints } from "../lib/code-point-order";
import { SIMULATOR_PROTOCOL_VERSION, type SimulatorCapabilities } from "./simulator-client";

export {
  createSimulatorClient,
  parseSimulatorSnapshot,
  SIMULATOR_PROTOCOL_VERSION,
  type SimulatorCapabilities,
  type SimulatorClockAdvanceResponse,
  type SimulatorDeploymentRequest,
  type SimulatorDeploymentResponse,
  type SimulatorEngineCapabilities,
  SimulatorHttpError,
  type SimulatorOperation,
  type SimulatorProviderOperationRequest,
  type SimulatorSnapshot,
  type SimulatorWorldRequest,
  type SimulatorWorldResponse,
} from "./simulator-client";

const MAX_SIMULATION_OVERLAY_BYTES = 1024 * 1024;
const MAX_SIMULATION_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SIMULATION_OVERLAY_FILENAME = "simulation.json";
const SIMULATION_ARTIFACT_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SIMULATION_SHA256 = /^[a-f0-9]{64}$/;
const SIMULATION_TARGET_ID = /^(default|[a-z][a-z0-9-]{0,31})$/;

const simulationArtifactSchema = z
  .object({
    path: z.string().max(256).regex(SIMULATION_ARTIFACT_PATH),
    sha256: z.string().regex(SIMULATION_SHA256),
  })
  .strict();
const simulationRequirementSchema = z
  .object({
    targetId: z.string().regex(SIMULATION_TARGET_ID),
    service: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
    resourceType: z.string().min(1).max(256),
    operation: z.string().regex(/^[A-Za-z][A-Za-z0-9.:_-]{0,127}$/),
    fidelity: z.enum(["L0", "L1", "L2", "L3", "L4"]),
    plane: z.enum(["deploy", "participant", "workload", "scoring", "operator", "access"]),
    artifact: simulationArtifactSchema.optional(),
  })
  .strict();
const simulationWorkloadSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    targetId: z.string().regex(SIMULATION_TARGET_ID),
    resourceRef: z.string().min(1).max(256),
    image: z
      .string()
      .regex(/^(?:[a-z0-9][a-z0-9._/-]*\/)?[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/),
    command: z.array(z.string().min(1).max(512)).min(1).max(32).optional(),
    containerPort: z.number().int().min(1024).max(65_535),
    healthPath: z
      .string()
      .max(256)
      .regex(/^\/[^?#\s]*$/)
      .optional(),
    artifact: simulationArtifactSchema.optional(),
  })
  .strict();
const simulationOverlayReferenceSchema = z
  .object({ schemaVersion: z.literal("1"), entry: z.literal(SIMULATION_OVERLAY_FILENAME) })
  .strict();
const simulationOverlayDocumentSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal("1"),
    requirements: z.array(simulationRequirementSchema).min(1).max(128).optional(),
    workloads: z.array(simulationWorkloadSchema).min(1).max(32).optional(),
  })
  .strict()
  .refine((value) => value.requirements !== undefined || value.workloads !== undefined, {
    message: "requirements or workloads is required",
  });

export type SimulationOverlayDocument = z.infer<typeof simulationOverlayDocumentSchema>;

export interface SimulatorRequirementRow {
  readonly provider: string;
  readonly engine: string;
  readonly entry: string;
  readonly operation: "deploy";
  readonly supported: boolean;
  readonly diagnostic?: string;
}

export interface SimulatorCapabilityReport {
  readonly protocolVersion: typeof SIMULATOR_PROTOCOL_VERSION;
  readonly supported: boolean;
  readonly requirements: readonly SimulatorRequirementRow[];
}

export interface SimulatedCloudProblemSummary {
  readonly problemId: string;
  readonly name: string;
  readonly category: string;
  readonly runtime: ProblemRuntimeDescriptor;
}

/** Catalog payload required to deploy one cloud problem through the local runtime port. */
export interface SimulatedCloudProblem extends SimulatedCloudProblemSummary {
  readonly description: string;
  readonly instructions: string;
  readonly problemDir: string;
  readonly templateBody: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly scoring?: Readonly<Record<string, unknown>>;
  readonly i18n?: Readonly<Record<string, unknown>>;
  /** Validated simulation.json document sent as the deployment request's top-level field. */
  readonly simulationOverlay?: SimulationOverlayDocument;
}

interface MetadataInput {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly runtime?: unknown;
  readonly cfnTemplate?: unknown;
  readonly description?: unknown;
  readonly instructions?: unknown;
  readonly scoring?: unknown;
  readonly i18n?: unknown;
  readonly simulationOverlay?: unknown;
  readonly simulationOverlayDocument?: unknown;
}

function readMetadata(problemDir: string): MetadataInput {
  return JSON.parse(readFileSync(join(problemDir, "metadata.json"), "utf8")) as MetadataInput;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function safeRelativeSegments(path: string, label: string): readonly string[] {
  if (path.length === 0 || path.includes("\0")) throw new Error(`${label} must be a relative path`);
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} must stay inside the problem directory`);
  }
  return segments;
}

function readRegularProblemFile(
  problemDir: string,
  path: string,
  label: string,
  maxBytes: number,
): Buffer {
  const segments = safeRelativeSegments(path, label);
  let current = resolve(problemDir);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain a symbolic link`);
    const last = index === segments.length - 1;
    if ((!last && !stat.isDirectory()) || (last && !stat.isFile())) {
      throw new Error(`${label} must resolve to a regular file with directory-only parents`);
    }
    if (last && stat.size > maxBytes)
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  return readFileSync(current);
}

function runtimeTargetIds(runtime: ProblemRuntimeDescriptor): ReadonlySet<string> {
  return new Set(
    isCompositeRuntime(runtime) ? runtime.targets.map((target) => target.id) : ["default"],
  );
}

function validateOverlayArtifact(
  problemDir: string,
  artifact: z.infer<typeof simulationArtifactSchema> | undefined,
  label: string,
): void {
  if (!artifact) return;
  const bytes = readRegularProblemFile(
    problemDir,
    artifact.path,
    `${label}.path`,
    MAX_SIMULATION_ARTIFACT_BYTES,
  );
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(`${label}.sha256 is stale for "${artifact.path}" (expected ${actual})`);
  }
}

function validateSimulationOverlaySemantics(
  problemDir: string,
  runtime: ProblemRuntimeDescriptor,
  overlay: SimulationOverlayDocument,
): void {
  const targetIds = runtimeTargetIds(runtime);
  const requirementIds = new Set<string>();
  for (const [index, requirement] of (overlay.requirements ?? []).entries()) {
    if (!targetIds.has(requirement.targetId)) {
      throw new Error(
        `simulation requirements[${index}].targetId="${requirement.targetId}" does not match a normalized runtime target`,
      );
    }
    const identity = [
      requirement.targetId,
      requirement.service,
      requirement.resourceType,
      requirement.operation,
      requirement.plane,
    ].join("|");
    if (requirementIds.has(identity)) {
      throw new Error(`simulation requirements[${index}] duplicates identity ${identity}`);
    }
    requirementIds.add(identity);
    validateOverlayArtifact(
      problemDir,
      requirement.artifact,
      `simulation requirements[${index}].artifact`,
    );
  }
  const workloadIds = new Set<string>();
  for (const [index, workload] of (overlay.workloads ?? []).entries()) {
    if (!targetIds.has(workload.targetId)) {
      throw new Error(
        `simulation workloads[${index}].targetId="${workload.targetId}" does not match a normalized runtime target`,
      );
    }
    if (workloadIds.has(workload.id)) {
      throw new Error(`simulation workloads[${index}].id="${workload.id}" is duplicated`);
    }
    workloadIds.add(workload.id);
    if (workload.command?.some((argument) => argument.includes("\0"))) {
      throw new Error(`simulation workloads[${index}].command must not contain a null byte`);
    }
    validateOverlayArtifact(
      problemDir,
      workload.artifact,
      `simulation workloads[${index}].artifact`,
    );
  }
}

function loadSimulationOverlay(
  problemDir: string,
  runtime: ProblemRuntimeDescriptor,
  metadata: MetadataInput,
): SimulationOverlayDocument | undefined {
  if (metadata.simulationOverlayDocument !== undefined) {
    throw new Error(
      "metadata.simulationOverlayDocument is reserved for the Simulator wire boundary",
    );
  }
  const conventionalPath = join(problemDir, SIMULATION_OVERLAY_FILENAME);
  if (metadata.simulationOverlay === undefined) {
    if (existsSync(conventionalPath)) {
      throw new Error(
        `${SIMULATION_OVERLAY_FILENAME} exists but metadata.simulationOverlay does not reference it`,
      );
    }
    return undefined;
  }
  const reference = simulationOverlayReferenceSchema.safeParse(metadata.simulationOverlay);
  if (!reference.success) {
    throw new Error(`metadata.simulationOverlay is invalid: ${reference.error.message}`);
  }
  const bytes = readRegularProblemFile(
    problemDir,
    reference.data.entry,
    "simulationOverlay.entry",
    MAX_SIMULATION_OVERLAY_BYTES,
  );
  let parsedJson: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `simulationOverlay.entry is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const overlay = simulationOverlayDocumentSchema.safeParse(parsedJson);
  if (!overlay.success) {
    throw new Error(`simulation overlay schema is invalid: ${overlay.error.message}`);
  }
  if (overlay.data.schemaVersion !== reference.data.schemaVersion) {
    throw new Error("simulation overlay schemaVersion does not match metadata.simulationOverlay");
  }
  validateSimulationOverlaySemantics(problemDir, runtime, overlay.data);
  return overlay.data;
}

interface SimulatorArtifact {
  readonly path: string;
  readonly content: string;
}

interface SimulatorArtifactTarget {
  readonly id: string;
  readonly provider: string;
  readonly engine: string;
  readonly entry: string;
  readonly artifacts: readonly SimulatorArtifact[];
}

function safeEntryPath(problemDir: string, entry: string): string {
  const root = resolve(problemDir);
  const segments = safeRelativeSegments(entry, "runtime entry");
  let path = root;
  for (const segment of segments) {
    path = join(path, segment);
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`runtime entry must not contain a symbolic link: ${entry}`);
    }
  }
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`runtime entry escapes the problem directory: ${entry}`);
  }
  if (!existsSync(path)) throw new Error(`runtime entry does not exist: ${entry}`);
  return path;
}

function artifactFiles(problemDir: string, entry: string): readonly SimulatorArtifact[] {
  const root = resolve(problemDir);
  const entryPath = safeEntryPath(root, entry);
  if (statSync(entryPath).isFile()) {
    return [{ path: relative(root, entryPath), content: readFileSync(entryPath, "utf8") }];
  }
  const pending = [entryPath];
  const files: SimulatorArtifact[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      if (item.isDirectory()) pending.push(path);
      else if (item.isFile()) {
        files.push({ path: relative(root, path), content: readFileSync(path, "utf8") });
      } else {
        throw new Error(`runtime artifact must be a regular file: ${relative(root, path)}`);
      }
    }
  }
  if (files.length === 0) throw new Error(`runtime entry directory is empty: ${entry}`);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function artifactTarget(
  problemDir: string,
  target: SingleRuntimeDescriptor & { readonly id?: string },
  fallbackId: string,
  overlayEntries: readonly string[] = [],
): SimulatorArtifactTarget {
  const artifacts = new Map<string, SimulatorArtifact>();
  for (const entry of [target.entry, ...overlayEntries]) {
    for (const artifact of artifactFiles(problemDir, entry)) {
      artifacts.set(artifact.path, artifact);
    }
  }
  return {
    id: target.id ?? fallbackId,
    provider: target.provider,
    engine: target.engine,
    entry: target.entry,
    artifacts: [...artifacts.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function overlayArtifactEntries(
  overlay: SimulationOverlayDocument | undefined,
): ReadonlyMap<string, readonly string[]> {
  const entries = new Map<string, Set<string>>();
  for (const item of [...(overlay?.requirements ?? []), ...(overlay?.workloads ?? [])]) {
    if (!item.artifact) continue;
    const targetEntries = entries.get(item.targetId) ?? new Set<string>();
    targetEntries.add(item.artifact.path);
    entries.set(item.targetId, targetEntries);
  }
  return new Map(
    [...entries].map(([targetId, targetEntries]) => [
      targetId,
      [...targetEntries].sort(compareCodePoints),
    ]),
  );
}

/**
 * A single-file runtime remains wire-compatible with the initial protocol.
 * Directories and composites use the deterministic v1 artifact bundle agreed
 * with Simulator so each target compiler receives its own catalog entry.
 */
export function simulatorTemplateBody(
  problemDir: string,
  runtime: ProblemRuntimeDescriptor,
  simulationOverlay?: SimulationOverlayDocument,
): string {
  const overlayEntries = overlayArtifactEntries(simulationOverlay);
  if (!isCompositeRuntime(runtime)) {
    const artifacts = artifactFiles(problemDir, runtime.entry);
    const extraEntries = overlayEntries.get("default") ?? [];
    if (
      extraEntries.length === 0 &&
      artifacts.length === 1 &&
      statSync(safeEntryPath(problemDir, runtime.entry)).isFile()
    ) {
      return artifacts[0].content;
    }
    return JSON.stringify({
      format: "tenkacloud.simulator.artifacts.v1",
      targets: [artifactTarget(problemDir, runtime, "default", extraEntries)],
    });
  }
  const targets = runtime.targets
    .map((target) =>
      artifactTarget(problemDir, target, target.id, overlayEntries.get(target.id) ?? []),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({ format: "tenkacloud.simulator.artifacts.v1", targets });
}

/** True for catalog runtimes delegated to TenkaCloud Simulator instead of Docker local play. */
export function isSimulatorRuntime(runtime: ProblemRuntimeDescriptor): boolean {
  if (isCompositeRuntime(runtime)) return true;
  return !isContainerRuntime(runtime);
}

function singleRequirements(runtime: SingleRuntimeDescriptor): readonly SimulatorRequirementRow[] {
  return [
    {
      provider: runtime.provider,
      engine: runtime.engine,
      entry: runtime.entry,
      operation: "deploy",
      supported: false,
    },
  ];
}

function requirementsFor(runtime: ProblemRuntimeDescriptor): readonly SimulatorRequirementRow[] {
  if (!isCompositeRuntime(runtime)) return singleRequirements(runtime);
  return runtime.targets.map((target) => ({
    provider: target.provider,
    engine: target.engine,
    entry: target.entry,
    operation: "deploy" as const,
    supported: false,
  }));
}

export function buildSimulatorCapabilityReport(
  runtimes: readonly ProblemRuntimeDescriptor[],
  capabilities: SimulatorCapabilities,
): SimulatorCapabilityReport {
  const requirements = runtimes.flatMap(requirementsFor).map((requirement) => {
    const engine = capabilities.providers[requirement.provider]?.engines[requirement.engine];
    const supported = engine?.operations.includes(requirement.operation) ?? false;
    return {
      ...requirement,
      supported,
      ...(supported
        ? {}
        : {
            diagnostic: `NotImplemented: ${requirement.provider}/${requirement.engine} ${requirement.operation} is not advertised by the simulator`,
          }),
    };
  });
  return {
    protocolVersion: SIMULATOR_PROTOCOL_VERSION,
    supported: requirements.every((requirement) => requirement.supported),
    requirements,
  };
}

function simulatedSummary(
  root: string,
  problemId: string,
): SimulatedCloudProblemSummary | undefined {
  const problemDir = join(root, problemId);
  if (!existsSync(join(problemDir, "metadata.json"))) return undefined;
  const metadata = readMetadata(problemDir);
  const runtime = normalizeRuntime({ ...metadata, id: problemId });
  if (!runtime || !isSimulatorRuntime(runtime)) return undefined;
  return {
    problemId,
    name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name : problemId,
    category: basename(root),
    runtime,
  };
}

export function listSimulatedCloudProblems(
  roots: readonly string[],
): readonly SimulatedCloudProblemSummary[] {
  const summaries: SimulatedCloudProblemSummary[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const problemIds = readdirSync(root, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    for (const problemId of problemIds) {
      try {
        const summary = simulatedSummary(root, problemId.name);
        if (summary) summaries.push(summary);
      } catch {
        // Listing is a chooser, not a validator; malformed problems are reported by validation CI.
      }
    }
  }
  return summaries.sort((a, b) => a.problemId.localeCompare(b.problemId));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load and validate cloud catalog records used by the real Simulator lifecycle. */
export function loadSimulatedCloudProblems(
  roots: readonly string[],
): readonly SimulatedCloudProblem[] {
  return listSimulatedCloudProblems(roots).map((summary) => {
    const problemDir = join(
      roots.find((root) => basename(root) === summary.category) ?? "",
      summary.problemId,
    );
    if (!problemDir || !existsSync(problemDir)) {
      throw new Error(`simulated problem directory was not found: ${summary.problemId}`);
    }
    const metadata = readMetadata(problemDir);
    const simulationOverlay = loadSimulationOverlay(problemDir, summary.runtime, metadata);
    return {
      ...summary,
      description: requiredText(metadata.description, `${summary.problemId}.description`),
      instructions: requiredText(metadata.instructions, `${summary.problemId}.instructions`),
      problemDir,
      templateBody: simulatorTemplateBody(problemDir, summary.runtime, simulationOverlay),
      metadata: metadata as Readonly<Record<string, unknown>>,
      ...(isRecord(metadata.scoring) ? { scoring: metadata.scoring } : {}),
      ...(isRecord(metadata.i18n) ? { i18n: metadata.i18n } : {}),
      ...(simulationOverlay ? { simulationOverlay } : {}),
    };
  });
}

/**
 * [Issue #2632] The multicloud Simulator problems (Issue #2631) are still being
 * brought up to catalog quality — endpoint URLs, access instructions, and problem
 * framing are inconsistent — so they are gated OFF by default. Opt in per session
 * with `TENKACLOUD_LOCAL_SIMULATOR=1 make local`. The value is parsed strictly
 * (only `1` / `true`, case- and whitespace-insensitive) so a stray truthy-looking
 * string cannot silently surface half-ready problems.
 */
export function isSimulatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.TENKACLOUD_LOCAL_SIMULATOR ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Gated accessor for the loadable simulated-cloud catalog. Returns an empty
 * catalog unless {@link isSimulatorEnabled}, so `make local` neither lists,
 * wires, nor serves Simulator problems by default.
 */
export function enabledSimulatedCloudProblems(
  roots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): readonly SimulatedCloudProblem[] {
  return isSimulatorEnabled(env) ? loadSimulatedCloudProblems(roots) : [];
}

/** Gated accessor for simulated-cloud catalog summaries (mirror of {@link enabledSimulatedCloudProblems}). */
export function enabledSimulatedCloudSummaries(
  roots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): readonly SimulatedCloudProblemSummary[] {
  return isSimulatorEnabled(env) ? listSimulatedCloudProblems(roots) : [];
}
