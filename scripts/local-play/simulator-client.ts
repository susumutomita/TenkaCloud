import type { ProblemRuntimeDescriptor } from "@tenkacloud/problem-runtime";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import type { SimulationOverlayDocument } from "./simulator";

const DEFAULT_SIMULATOR_REQUEST_TIMEOUT_MS = 10_000;

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
  readonly simulationOverlay?: SimulationOverlayDocument;
}

export interface SimulatorDeploymentResponse {
  readonly deploymentId: string;
  readonly status: "accepted" | "deploying" | "running" | "failed" | "deleting" | "deleted";
  readonly outputs: Readonly<Record<string, string>>;
  readonly diagnostics?: readonly { readonly message: string }[];
}

export interface SimulatorSnapshot {
  readonly snapshotVersion: string;
  readonly protocolVersion: string;
  readonly worldId: string;
  readonly namespace: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export interface SimulatorClockAdvanceResponse {
  readonly clock: string;
  readonly appliedTransitions: readonly {
    readonly provider: string;
    readonly transitionId: string;
  }[];
}

export interface SimulatorProviderOperationRequest {
  readonly deploymentId: string;
  readonly targetId: string;
  readonly engine: string;
  readonly service: string;
  readonly resourceType: string;
  readonly input: Readonly<Record<string, unknown>>;
}

const simulatorCapabilitiesSchema = z.object({
  protocolVersion: z.string(),
  providers: z.record(
    z.string(),
    z.object({
      engines: z.record(
        z.string(),
        z.object({
          operations: z.array(z.enum(["deploy", "delete", "get", "capabilities", "world"])),
          resources: z.array(z.string()).optional(),
          fidelity: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
});

const simulatorWorldResponseSchema = z.object({
  worldId: z.string().min(1),
  consoleUrl: z.string().url(),
});

const simulatorDeploymentResponseSchema = z.object({
  deploymentId: z.string().min(1),
  status: z.enum(["accepted", "deploying", "running", "failed", "deleting", "deleted"]),
  outputs: z.record(z.string(), z.string()),
  diagnostics: z.array(z.object({ message: z.string() }).passthrough()).optional(),
});

const simulatorSnapshotSchema = z
  .object({
    snapshotVersion: z.string(),
    protocolVersion: z.string(),
    worldId: z.string().min(1),
    namespace: z.record(z.string(), z.string()),
  })
  .passthrough();
const simulatorOperationResponseSchema = z.record(z.string(), z.unknown());
const simulatorClockAdvanceResponseSchema = z
  .object({
    clock: z.string().datetime(),
    appliedTransitions: z.array(
      z
        .object({
          provider: z.string().min(1),
          transitionId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

async function parseJson<T>(response: Response, label: string, schema: z.ZodType<T>): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}): ${text}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} returned an invalid response: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function boundedFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  requestTimeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Simulator request timed out after ${requestTimeoutMs}ms`));
    }, requestTimeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetchFn(url, { ...init, signal: controller.signal });
      // Fetch resolves at headers. Keep the deadline active until the body is
      // complete so a stalled local process cannot wedge lifecycle or cleanup.
      const body = await response.arrayBuffer();
      const bodyForbidden =
        response.status === StatusCodes.NO_CONTENT ||
        response.status === StatusCodes.RESET_CONTENT ||
        response.status === StatusCodes.NOT_MODIFIED;
      return new Response(bodyForbidden ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    })();
    return await Promise.race([request, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createSimulatorClient(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  launchToken?: string,
  requestTimeoutMs = DEFAULT_SIMULATOR_REQUEST_TIMEOUT_MS,
) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("Simulator request timeout must be a positive safe integer");
  }
  const base = baseUrl.replace(/\/$/, "");
  const protocolHeaders: Record<string, string> = {
    "x-tenkacloud-simulator-protocol": SIMULATOR_PROTOCOL_VERSION,
  };
  if (launchToken) protocolHeaders.authorization = `Bearer ${launchToken}`;
  const authenticatedHeaders = (json = false): Record<string, string> => {
    if (!launchToken) {
      throw new Error("Simulator world operations require a launch token");
    }
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...protocolHeaders,
    };
  };
  const timedFetch = (url: string, init?: RequestInit): Promise<Response> =>
    boundedFetch(fetchFn, url, init, requestTimeoutMs);
  return {
    async capabilities(): Promise<SimulatorCapabilities> {
      return parseJson<SimulatorCapabilities>(
        await timedFetch(`${base}/v1/capabilities`, { headers: protocolHeaders }),
        "capabilities",
        simulatorCapabilitiesSchema,
      );
    },
    async createWorld(request: SimulatorWorldRequest): Promise<SimulatorWorldResponse> {
      return parseJson<SimulatorWorldResponse>(
        await timedFetch(`${base}/v1/worlds`, {
          method: "POST",
          headers: authenticatedHeaders(true),
          body: JSON.stringify(request),
        }),
        "create world",
        simulatorWorldResponseSchema,
      );
    },
    async createDeployment(
      worldId: string,
      request: SimulatorDeploymentRequest,
    ): Promise<SimulatorDeploymentResponse> {
      return parseJson<SimulatorDeploymentResponse>(
        await timedFetch(`${base}/v1/worlds/${encodeURIComponent(worldId)}/deployments`, {
          method: "POST",
          headers: authenticatedHeaders(true),
          body: JSON.stringify(request),
        }),
        "create deployment",
        simulatorDeploymentResponseSchema,
      );
    },
    async getDeployment(
      worldId: string,
      deploymentId: string,
    ): Promise<SimulatorDeploymentResponse> {
      return parseJson<SimulatorDeploymentResponse>(
        await timedFetch(
          `${base}/v1/worlds/${encodeURIComponent(worldId)}/deployments/${encodeURIComponent(deploymentId)}`,
          { headers: authenticatedHeaders() },
        ),
        "get deployment",
        simulatorDeploymentResponseSchema,
      );
    },
    async deleteWorld(worldId: string): Promise<void> {
      const response = await timedFetch(`${base}/v1/worlds/${encodeURIComponent(worldId)}`, {
        method: "DELETE",
        headers: authenticatedHeaders(),
      });
      if (!response.ok) {
        throw new Error(`delete world failed (HTTP ${response.status}): ${await response.text()}`);
      }
    },
    async exportSnapshot(worldId: string): Promise<SimulatorSnapshot> {
      return parseJson<SimulatorSnapshot>(
        await timedFetch(`${base}/v1/worlds/${encodeURIComponent(worldId)}/snapshots`, {
          headers: authenticatedHeaders(),
        }),
        "export snapshot",
        simulatorSnapshotSchema,
      );
    },
    async importSnapshot(
      worldId: string,
      snapshot: SimulatorSnapshot,
    ): Promise<SimulatorWorldResponse> {
      return parseJson<SimulatorWorldResponse>(
        await timedFetch(`${base}/v1/worlds/${encodeURIComponent(worldId)}/snapshots`, {
          method: "POST",
          headers: authenticatedHeaders(true),
          body: JSON.stringify(snapshot),
        }),
        "import snapshot",
        simulatorWorldResponseSchema,
      );
    },
    async advanceClock(
      worldId: string,
      milliseconds: number,
    ): Promise<SimulatorClockAdvanceResponse> {
      if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
        throw new Error("Simulator clock advance must be a positive safe integer");
      }
      return parseJson<SimulatorClockAdvanceResponse>(
        await timedFetch(`${base}/v1/worlds/${encodeURIComponent(worldId)}/clock/advance`, {
          method: "POST",
          headers: authenticatedHeaders(true),
          body: JSON.stringify({ milliseconds }),
        }),
        "advance clock",
        simulatorClockAdvanceResponseSchema,
      );
    },
    async executeProviderOperation(
      worldId: string,
      provider: string,
      operation: string,
      request: SimulatorProviderOperationRequest,
      idempotencyKey: string,
    ): Promise<Readonly<Record<string, unknown>>> {
      if (!idempotencyKey.trim()) {
        throw new Error("Simulator provider operation requires an idempotency key");
      }
      return parseJson(
        await timedFetch(
          `${base}/v1/worlds/${encodeURIComponent(worldId)}/providers/${encodeURIComponent(provider)}/operations/${encodeURIComponent(operation)}`,
          {
            method: "POST",
            headers: {
              ...authenticatedHeaders(true),
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify(request),
          },
        ),
        "execute provider operation",
        simulatorOperationResponseSchema,
      );
    },
  };
}
