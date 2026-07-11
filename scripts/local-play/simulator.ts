import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  isCompositeRuntime,
  isContainerRuntime,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
  type SingleRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";

/** The pinned TenkaCloud Simulator protocol version consumed by this repo. */
export const SIMULATOR_PROTOCOL_VERSION = "2026-07-11" as const;

export type SimulatorOperation = "deploy" | "delete" | "get" | "capabilities" | "world";

export interface SimulatorEngineCapabilities {
  readonly operations: readonly SimulatorOperation[];
  readonly resources?: readonly string[];
  readonly fidelity?: readonly string[];
}

export interface SimulatorCapabilities {
  readonly protocolVersion: string;
  readonly providers: Readonly<
    Record<
      string,
      {
        readonly engines: Readonly<Record<string, SimulatorEngineCapabilities>>;
      }
    >
  >;
}

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

interface MetadataInput {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly runtime?: unknown;
  readonly cfnTemplate?: unknown;
}

function readMetadata(problemDir: string): MetadataInput {
  return JSON.parse(readFileSync(join(problemDir, "metadata.json"), "utf8")) as MetadataInput;
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

async function parseJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}): ${text}`);
  return JSON.parse(text) as T;
}

export interface SimulatorWorldRequest {
  readonly tenantId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly deploymentId: string;
  readonly seed?: string;
}

export interface SimulatorWorldResponse {
  readonly worldId: string;
  readonly consoleUrl: string;
}

export interface SimulatorDeploymentRequest {
  readonly problemId: string;
  readonly runtime: ProblemRuntimeDescriptor;
  readonly templateBody: string;
  readonly metadata?: unknown;
}

export interface SimulatorDeploymentResponse {
  readonly deploymentId: string;
  readonly status: string;
  readonly outputs: Readonly<Record<string, string>>;
}

export function createSimulatorClient(baseUrl: string, fetchFn: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/$/, "");
  const jsonHeaders = {
    "content-type": "application/json",
    "x-tenkacloud-simulator-protocol": SIMULATOR_PROTOCOL_VERSION,
  };
  return {
    async capabilities(): Promise<SimulatorCapabilities> {
      return parseJson<SimulatorCapabilities>(
        await fetchFn(`${base}/v1/capabilities`),
        "capabilities",
      );
    },
    async createWorld(request: SimulatorWorldRequest): Promise<SimulatorWorldResponse> {
      return parseJson<SimulatorWorldResponse>(
        await fetchFn(`${base}/v1/worlds`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(request),
        }),
        "create world",
      );
    },
    async createDeployment(
      worldId: string,
      request: SimulatorDeploymentRequest,
    ): Promise<SimulatorDeploymentResponse> {
      return parseJson<SimulatorDeploymentResponse>(
        await fetchFn(`${base}/v1/worlds/${encodeURIComponent(worldId)}/deployments`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(request),
        }),
        "create deployment",
      );
    },
    async getDeployment(
      worldId: string,
      deploymentId: string,
    ): Promise<SimulatorDeploymentResponse> {
      return parseJson<SimulatorDeploymentResponse>(
        await fetchFn(
          `${base}/v1/worlds/${encodeURIComponent(worldId)}/deployments/${encodeURIComponent(deploymentId)}`,
        ),
        "get deployment",
      );
    },
    async deleteWorld(worldId: string): Promise<void> {
      const response = await fetchFn(`${base}/v1/worlds/${encodeURIComponent(worldId)}`, {
        method: "DELETE",
        headers: { "x-tenkacloud-simulator-protocol": SIMULATOR_PROTOCOL_VERSION },
      });
      if (!response.ok)
        throw new Error(`delete world failed (HTTP ${response.status}): ${await response.text()}`);
    },
  };
}
