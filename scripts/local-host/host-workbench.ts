import { z } from "zod";
import { type WorkbenchAction, WorkbenchClientError } from "./container/workbench-client";
import { definitionKind, HostError, type Job } from "./model";
import type { ApiRequest, ApiResponse, HostingService } from "./service";
import { digest } from "./store";

const actionSchema = z.enum(["config", "starter", "inspect", "test", "prepare"]);
const entriesSchema = z.record(z.string().min(1).max(240), z.string().max(64 * 1024));
const filesSchema = entriesSchema.refine((files) => Object.keys(files).length <= 16);
const manualSchema = entriesSchema.refine((manual) => Object.keys(manual).length <= 32);
const requestSchemas = {
  test: z.object({ files: filesSchema }).strict(),
  prepare: z.object({ files: filesSchema, manual: manualSchema }).strict(),
};
const readActions = new Set<WorkbenchAction>(["config", "starter", "inspect"]);

function requestBody(request: ApiRequest, action: WorkbenchAction): unknown {
  if (readActions.has(action)) {
    if (request.method !== "GET") throw new HostError(405, "Use GET for this workbench action.");
    if (
      !z
        .object({})
        .strict()
        .safeParse(request.body ?? {}).success
    )
      throw new HostError(400, "Workbench reads do not accept request data.");
    return undefined;
  }
  if (request.method !== "POST") throw new HostError(405, "Use POST for this workbench action.");
  const schema = action === "test" ? requestSchemas.test : requestSchemas.prepare;
  const body = schema.safeParse(request.body);
  if (!body.success || new TextEncoder().encode(JSON.stringify(body.data)).byteLength > 64 * 1024)
    throw new HostError(400, "Invalid workbench request data.");
  return body.data;
}

function route(request: ApiRequest): {
  problemId: string;
  action: WorkbenchAction;
  body?: unknown;
} {
  const match = /^\/portal\/me\/problems\/([^/]+)\/workbench\/([^/]+)$/u.exec(request.path);
  if (!match) throw new HostError(404, "Unknown workbench endpoint.");
  let problemId: string;
  try {
    problemId = decodeURIComponent(match[1] ?? "");
  } catch {
    throw new HostError(400, "Invalid workbench problem.");
  }
  const parsedAction = actionSchema.safeParse(match[2]);
  if (!parsedAction.success || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(problemId))
    throw new HostError(404, "Unknown workbench endpoint.");
  const action = parsedAction.data;
  if (request.query.size !== 0)
    throw new HostError(400, "Workbench requests do not accept query parameters.");
  return { problemId, action, body: requestBody(request, action) };
}

function resolveJob(service: HostingService, request: ApiRequest, problemId: string): Job {
  const team = service.store.authenticateTeam(request.token);
  const job = service.store
    .jobs(team.eventId, team.teamId)
    .find((item) => item.problemId === problemId);
  if (!job) throw new HostError(404, "This team has no such problem.", "unknown_problem");
  const authorized = service.authorizeSurface(job.jobId, digest(request.token));
  const event = service.store.event(team.eventId);
  if (
    authorized.teamId !== team.teamId ||
    authorized.eventId !== team.eventId ||
    !authorized.unit ||
    definitionKind(authorized.definition) !== "compose" ||
    !event.problems.some(
      (problem) =>
        problem.problemId === problemId &&
        problem.definition === authorized.definition &&
        (problem.runtime ?? "docker") === "docker",
    )
  )
    throw new HostError(409, "This problem has no running container workbench.", "not_ready");
  return { ...authorized };
}

/** A workbench can use only the authenticated team's currently authorized deployment. */
export async function hostWorkbench(
  service: HostingService,
  request: ApiRequest,
): Promise<ApiResponse> {
  service.store.authenticateTeam(request.token);
  const { problemId, action, body } = route(request);
  const initial = resolveJob(service, request, problemId);
  if (!service.engine.workbench)
    throw new HostError(404, "This problem has no container editor.", "workbench_not_supported");
  const assertCurrent = () => {
    const current = resolveJob(service, request, problemId);
    if (
      current.jobId !== initial.jobId ||
      current.unit !== initial.unit ||
      current.definition !== initial.definition ||
      current.deployedAt !== initial.deployedAt
    )
      throw new HostError(409, "This environment changed. Reopen the workbench.", "not_ready");
  };
  try {
    const result = await service.engine.workbench({ ...initial }, action, body);
    assertCurrent();
    if (action === "config" && !z.object({ id: z.literal(problemId) }).safeParse(result).success)
      throw new HostError(
        502,
        "The container editor returned another problem configuration.",
        "workbench_unavailable",
      );
    return { status: 200, body: result };
  } catch (error) {
    assertCurrent();
    if (error instanceof WorkbenchClientError) {
      if (error.code === "not_supported")
        throw new HostError(
          404,
          "This problem has no container editor.",
          "workbench_not_supported",
        );
      throw new HostError(
        502,
        "The container editor is unavailable. Try again later.",
        "workbench_unavailable",
      );
    }
    throw error;
  }
}
