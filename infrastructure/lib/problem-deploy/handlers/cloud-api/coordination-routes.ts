import type { Context, Hono } from "hono";
import { z } from "zod";
import type { CloudDeploymentsCoordination } from "../../control-data/cloud-data-ports.js";
import type { CloudRepository } from "../../control-data/cloud-repository.js";
import { assertResetOpen } from "../../control-data/coordination-runs.js";
import type {
  NativeCoordinationArtifact,
  NativeCoordinationRun,
} from "../../control-data/domain/coordination.js";
import { contentDigest } from "../../control-data/domain/deployment-work.js";
import type { EventRecord } from "../../control-data/domain/events.js";
import type { TeamRecord } from "../../control-data/domain/teams.js";
import { ApiError, type OrganizerAuthConfig, participantKey, requireOrganizer } from "./auth.js";
import type { createNativeArtifactResolver, NativeProblem } from "./execution-config.js";
import { body, identifier } from "./schema.js";

export interface CloudCoordinationApi {
  readonly store: CloudDeploymentsCoordination;
  readonly catalog: () => Promise<Readonly<Record<string, NativeProblem>>>;
  readonly resolve: ReturnType<typeof createNativeArtifactResolver>;
}
export const NATIVE_BATTLE_ID = "ac26-crypto-battle";
export function nativeProblem(event: EventRecord): string | undefined {
  return event.problems.find((problem) => problem.problemId === NATIVE_BATTLE_ID)?.problemId;
}
type NativePin = Pick<
  NativeCoordinationRun,
  "catalogKey" | "artifactDigest" | "pluginKey" | "problemId"
> &
  Partial<Pick<NativeCoordinationRun, "match">>;
async function resolveNative(api: CloudCoordinationApi, pin: NativePin) {
  try {
    const result = await api.resolve(pin);
    if (pin.match && pin.match.stateSchemaVersion !== (result.plugin.stateSchemaVersion ?? 1))
      throw new Error("Native state schema changed.");
    return result;
  } catch (error) {
    console.error(
      "[cloud-api] native artifact unavailable",
      error instanceof Error ? error.name : "Error",
    );
    throw new ApiError(503, "coordination_unavailable");
  }
}
export async function nativeArtifact(
  api: CloudCoordinationApi,
  pin: NativePin,
): Promise<NativeCoordinationArtifact> {
  const { descriptor, plugin } = await resolveNative(api, pin);
  return {
    problemId: descriptor.problemId,
    artifactDigest: descriptor.artifactDigest,
    pluginKey: descriptor.pluginKey,
    catalogKey: descriptor.catalogKey,
    stateBudget: descriptor.stateBudget,
    plugin,
  };
}
export async function nativeRun(api: CloudCoordinationApi, event: EventRecord) {
  const problemId = nativeProblem(event);
  return problemId ? api.store.read(event.eventId, problemId) : undefined;
}
export async function nativeSummary(api: CloudCoordinationApi, event: EventRecord) {
  const problemId = nativeProblem(event);
  return problemId ? api.store.summary(event.eventId, problemId) : undefined;
}
/** A descriptor exists only after the authoritative native run has been initialized. */
export async function nativeParticipantProblems(
  api: CloudCoordinationApi,
  event: EventRecord,
  team: TeamRecord,
) {
  if (["TEARDOWN", "ARCHIVED"].includes(event.status)) return [];
  const run = await nativeRun(api, event);
  if (!run?.roster.some((entry) => entry.teamId === team.teamId)) return [];
  const { descriptor } = await resolveNative(api, run);
  return [
    {
      runtimeKind: "coordination" as const,
      coordination: true as const,
      jobId: run.runId,
      problemId: run.problemId,
      status: "COMPLETE" as const,
      expiresAt: event.expiresAt,
      score: run.match.scores[team.teamId] ?? 0,
      stackOutputs: {},
      accessCapabilities: [],
      name: descriptor.name,
      description: descriptor.description,
      instructions: descriptor.instructions,
      ...(descriptor.i18n ? { i18n: descriptor.i18n } : {}),
      createdAt: event.createdAt,
      deployLog: { cursor: String(run.revision), entries: [] },
    },
  ];
}
export async function settleNativeEvent(
  api: CloudCoordinationApi,
  event: EventRecord,
  now: () => number,
  patch: Parameters<CloudDeploymentsCoordination["changeSchedule"]>[0]["patch"],
  close = false,
) {
  const summary = await nativeSummary(api, event);
  if (!summary) return undefined;
  if (summary.purgeState) {
    if (!close) throw new ApiError(409, "coordination_run_closed");
    if (summary.purgeState === "pending") await api.store.purge(event.eventId, summary.problemId);
    await api.store.closeFence(event.eventId, summary.problemId);
    return event;
  }
  const run = await nativeRun(api, event);
  if (!run) return undefined;
  const artifact = await nativeArtifact(api, run);
  if (close && event.status === "ARCHIVED") {
    await api.store.closeFence(event.eventId, run.problemId);
    return event;
  }
  return api.store.changeSchedule({
    event,
    artifact,
    patch,
    now,
    close,
  });
}
async function operationInput(context: Context, method: "get" | "post") {
  if (method === "get") return undefined;
  const input = z
    .object({ op: z.unknown(), runId: identifier.optional() })
    .strict()
    .parse(await body(context));
  if (!("op" in input)) throw new ApiError(400, "invalid_request");
  const key = z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u)
    .parse(context.req.header("Idempotency-Key"));
  return {
    key,
    hash: contentDigest(JSON.stringify({ op: input.op })),
    op: input.op,
    ...(input.runId ? { runId: input.runId } : {}),
  };
}
interface RouteOptions extends CloudCoordinationApi {
  readonly repository: CloudRepository;
  readonly organizerAuth: OrganizerAuthConfig;
  readonly now: () => number;
}
async function reset(context: Context, options: RouteOptions) {
  requireOrganizer(context, ["Admin", "Operator"], options.organizerAuth, options.now());
  const eventId = identifier.parse(context.req.param("eventId"));
  const event = await options.repository.getEvent(eventId);
  if (!event) throw new ApiError(404, "not_found");
  const problemId = context.req.param("problemId") ?? "";
  if (problemId !== nativeProblem(event)) throw new ApiError(404, "coordination_not_configured");
  const run = await options.store.read(eventId, problemId);
  if (!run || run.eventId !== eventId || run.problemId !== problemId)
    throw new ApiError(404, "coordination_not_initialized");
  const input = z
    .object({ runId: identifier.optional() })
    .strict()
    .parse((await context.req.text()) ? await body(context) : {});
  if (input.runId && input.runId !== run.runId) throw new ApiError(409, "run_rotation_conflict");
  assertResetOpen(event, options.now());
  if (run.closed) throw new ApiError(409, "event_ended");
  const result = await options.store.reset({
    event,
    artifact: await nativeArtifact(options, run),
    expectedRunId: run.runId,
    now: options.now,
  });
  return context.json(result, 200);
}
export function registerCloudCoordinationRoutes(app: Hono, options: RouteOptions) {
  app.post("/events/:eventId/problems/:problemId/coordination/reset", (context) =>
    reset(context, options),
  );
  for (const method of ["get", "post"] as const) {
    app[method](
      `/portal/me/coordination/${method === "get" ? "projection" : "op"}`,
      async (context) => {
        const team = await options.repository.authenticateTeam(
          participantKey(context.req.header("Authorization")),
          options.now(),
        );
        if (!team) throw new ApiError(401, "unauthorized");
        const event = await options.repository.getEvent(team.eventId);
        if (!event) throw new ApiError(404, "not_found");
        const run = await nativeRun(options, event);
        if (!run) throw new ApiError(404, "coordination_not_initialized");
        const operation = await operationInput(context, method);
        const result = await options.store.request({
          event,
          team,
          artifact: await nativeArtifact(options, run),
          now: options.now,
          ...(operation ? { operation } : {}),
        });
        return context.json(result.body, result.status);
      },
    );
  }
}
