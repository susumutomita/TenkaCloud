import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDefaultUrl } from "@tenkacloud/problem-sdk/internal";
import { StatusCodes } from "http-status-codes";
import { revealHint, scoreSimulatedProblem, submitFlag } from "./api-scoring";
import {
  LOCAL_CONTEXT,
  type LocalPlayRequest,
  type LocalPlayResponse,
  type LocalPlayState,
  type SimulatedProblemRuntime,
} from "./api-state";
import { leaderboard, teamView } from "./api-views";
import { parseLoopbackUrl } from "./loopback";
import { participantSimulatorOutputs, simulatorOutput } from "./simulator-scoring";
import { type WorkbenchAction, WorkbenchClientError } from "./workbench-client";

/**
 * [#2527 Slice 6] The local scoring API's HTTP routing + on-demand lifecycle commands.
 * The contract and session state live in `api-state.ts`, the portal views in
 * `api-views.ts`, and the submission/scoring use cases in `api-scoring.ts` — this file
 * only routes requests to them. It owns the participant-facing portal contract but
 * holds NO answer: a flag submission is delegated to the problem container's `/verify`
 * and the verdict is recorded (Issue #2054).
 */

/** [#2392 Phase 2] POST /portal/me/problems/:id/start — on-demand container start. */
async function startProblem(
  problemId: string,
  state: LocalPlayState,
  now: number,
): Promise<LocalPlayResponse> {
  if (!state.runtimes.has(problemId) && !state.simulatedRuntimes.has(problemId)) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  }
  // [#3008] Answer the host-compatibility refusal here, synchronously. The container path
  // below returns 202 and reports failures through polled lifecycle status, which is right
  // for a start that might still succeed — but this one never can on this machine, and a
  // participant deserves the reason immediately rather than after a poll cycle.
  const compatibility = state.lifecycle.compatibilityOf(problemId);
  if (!compatibility.supported) {
    return {
      status: StatusCodes.UNPROCESSABLE_ENTITY,
      body: {
        error: "incompatible_host",
        code: compatibility.code,
        message: compatibility.message,
        messageJa: compatibility.messageJa,
        ...(compatibility.requiredArchitectures
          ? { requiredArchitectures: compatibility.requiredArchitectures }
          : {}),
        ...(compatibility.hostArchitecture
          ? { hostArchitecture: compatibility.hostArchitecture }
          : {}),
        ...(compatibility.missingCpuFlags
          ? { missingCpuFlags: compatibility.missingCpuFlags }
          : {}),
      },
    };
  }
  const simulated = state.simulatedRuntimes.get(problemId);
  if (simulated) {
    try {
      await state.lifecycle.ensureRunning(problemId);
      if (simulated.contract.scoring.kind !== "flag") {
        await scoreSimulatedProblem(problemId, state, now);
      }
    } catch {
      // Fail loudly: a simulator that would not come up must not look playable.
      return {
        status: StatusCodes.BAD_GATEWAY,
        body: { error: "start_failed", message: "Simulator problem failed to start" },
      };
    }
    return { status: StatusCodes.OK, body: { status: state.lifecycle.statusOf(problemId) } };
  }
  // Container (docker compose) 問題は応答を待たずに 202 で返す。 初回 start は
  // compose の暗黙イメージビルド (例: ai-riscv-screen-repair の RISC-V toolchain で
  // 数分) を含み、 同期応答は GitHub Codespaces の forwarded proxy が長時間リクエスト
  // を切断して必ず失敗する。 進行/失敗は lifecycle status ("starting" / "running" /
  // "error" + lastError) を portal の既存 polling が読む (AGENTS.md の polling 方針)。
  state.lifecycle.ensureRunning(problemId).catch(() => {
    // 失敗は lifecycle entry (status "error" + error message) に記録済みで、
    // team view の lastError として届く。 ここは detached promise の unhandled
    // rejection を防ぐだけ (握りつぶしではない)。
  });
  return {
    status: StatusCodes.ACCEPTED,
    body: { status: state.lifecycle.statusOf(problemId) ?? "starting" },
  };
}

/** [#2392 Phase 2] POST /portal/me/problems/:id/stop — release the container + its port slot. */
async function stopProblem(problemId: string, state: LocalPlayState): Promise<LocalPlayResponse> {
  if (!state.runtimes.has(problemId) && !state.simulatedRuntimes.has(problemId)) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  }
  await state.lifecycle.stop(problemId);
  for (const [ticket, handoff] of state.consoleHandoffs) {
    if (handoff.problemId === problemId) state.consoleHandoffs.delete(ticket);
  }
  return { status: StatusCodes.OK, body: { status: state.lifecycle.statusOf(problemId) } };
}

const START_RE = /^\/portal\/me\/problems\/([^/]+)\/start$/;
const STOP_RE = /^\/portal\/me\/problems\/([^/]+)\/stop$/;
const RESET_RE = /^\/portal\/me\/problems\/([^/]+)\/reset$/;
const CONSOLE_HANDOFF_RE = /^\/portal\/me\/problems\/([^/]+)\/console-handoff$/;
const CONSOLE_RE = /^\/portal\/me\/problems\/([^/]+)\/console$/;
const TERMINAL_HANDOFF_RE = /^\/portal\/me\/problems\/([^/]+)\/terminal-handoff$/;
const SCORE_RE = /^\/portal\/me\/problems\/([^/]+)\/score$/;
const ENDPOINTS_RE = /^\/portal\/me\/problems\/([^/]+)\/endpoints$/;
const ENDPOINT_RE = /^\/portal\/me\/problems\/([^/]+)\/endpoints\/([^/]+)$/;
const DISRUPTION_RE = /^\/local\/operator\/problems\/([^/]+)\/disruptions\/([^/]+)\/fire$/;
const SNAPSHOT_RE = /^\/local\/operator\/problems\/([^/]+)\/snapshots\/([^/]+)\/(export|import)$/;
const REVEAL_RE = /^\/portal\/me\/problems\/([^/]+)\/hints\/([^/]+)\/reveal$/;
const WORKBENCH_RE =
  /^\/portal\/me\/problems\/([^/]+)\/workbench\/(config|starter|inspect|test|prepare)$/;
const CONSOLE_HANDOFF_TTL_MS = 30_000;
/** [#2846] Long enough for one browser upgrade, short enough that a leaked ticket is dead. */
const TERMINAL_HANDOFF_TTL_MS = 30_000;

/** Decode one percent-escaped path segment; undefined when malformed (→ 404, not 500). */
function decodePathSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * Both console handoff handlers (mint + redeem) gate on the same thing: the path
 * segment must name a simulated-cloud problem whose world is deployed and running.
 * Returns the error response to emit, or the resolved problem + live deployment.
 */
function resolveRunningSimulatedConsole(
  state: LocalPlayState,
  rawSegment: string,
):
  | { readonly response: LocalPlayResponse }
  | {
      readonly problemId: string;
      readonly deployment: NonNullable<SimulatedProblemRuntime["deployment"]>;
    } {
  const problemId = decodePathSegment(rawSegment);
  const runtime = problemId ? state.simulatedRuntimes.get(problemId) : undefined;
  if (problemId === undefined || !runtime) {
    return {
      response: { status: StatusCodes.NOT_FOUND, body: { error: "unknown_simulated_problem" } },
    };
  }
  if (state.lifecycle.statusOf(problemId) !== "running" || !runtime.deployment) {
    return { response: { status: StatusCodes.CONFLICT, body: { error: "not_running" } } };
  }
  return { problemId, deployment: runtime.deployment };
}

async function handleConsoleHandoffGet(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now: number,
): Promise<LocalPlayResponse | undefined> {
  const match = CONSOLE_RE.exec(request.path);
  if (!match) return undefined;
  const resolved = resolveRunningSimulatedConsole(state, match[1]);
  if ("response" in resolved) return resolved.response;
  const { problemId, deployment } = resolved;
  const ticket = request.query.ticket;
  const handoff = ticket ? state.consoleHandoffs.get(ticket) : undefined;
  if (ticket) state.consoleHandoffs.delete(ticket);
  if (
    !handoff ||
    handoff.problemId !== problemId ||
    handoff.deploymentId !== deployment.deploymentId ||
    handoff.expiresAtMs <= now
  ) {
    return { status: StatusCodes.UNAUTHORIZED, body: { error: "invalid_console_handoff" } };
  }
  const consoleUrl = state.simulator
    ? await state.simulator.consoleUrl(problemId)
    : deployment.consoleUrl;
  return {
    status: StatusCodes.SEE_OTHER,
    body: undefined,
    headers: {
      "cache-control": "no-store",
      location: state.browserText(consoleUrl),
      "referrer-policy": "no-referrer",
    },
  };
}

async function handleGet(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now: number,
): Promise<LocalPlayResponse | undefined> {
  const consoleHandoff = await handleConsoleHandoffGet(request, state, now);
  if (consoleHandoff) return consoleHandoff;
  const workbench = WORKBENCH_RE.exec(request.path);
  if (workbench) return handleWorkbench(request, workbench, state);
  const endpoints = ENDPOINTS_RE.exec(request.path);
  if (endpoints) {
    const problemId = decodePathSegment(endpoints[1]);
    if (problemId === undefined) {
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
    }
    return simulatorEndpoints(problemId, state);
  }
  switch (request.path) {
    case "/healthz":
      return {
        status: StatusCodes.OK,
        body: {
          status: "ok",
          mode: "local",
          problemIds: [...state.runtimes.keys(), ...state.simulatedRuntimes.keys()],
        },
      };
    case "/portal/me":
      return teamView(state, now);
    // [#2925 / #2926] The participant-facing problem catalog. The portal used to get this
    // from a build-time glob over `problems/`, which the Docker image deliberately excludes
    // (it serves the participant's own bind-mounted clone instead), leaving every
    // catalog-derived surface blank. Entries are pre-projected by `metadataToEntry` — the
    // same fairness projection the build-time path uses — so `description` and non-public
    // phases/disruptions are already gone before anything reaches this response.
    case "/portal/problem-catalog":
      return { status: StatusCodes.OK, body: { entries: state.problemCatalog } };
    case "/portal/me/score-events":
      return { status: StatusCodes.OK, body: { entries: state.scoreEvents } };
    case "/portal/leaderboard":
      return leaderboard(state);
    case "/portal/leaderboard/score-events":
      return {
        status: StatusCodes.OK,
        body: {
          eventId: LOCAL_CONTEXT.eventId,
          teams: [
            {
              teamId: LOCAL_CONTEXT.teamId,
              teamName: state.teamName,
              isMyTeam: true,
              events: state.scoreEvents,
            },
          ],
        },
      };
    case "/portal/me/notifications":
      return { status: StatusCodes.OK, body: { eventId: LOCAL_CONTEXT.eventId, items: [] } };
    case "/portal/me/deploy-logs":
      return {
        status: StatusCodes.OK,
        body: { jobId: request.query.jobId ?? "", complete: true, entries: [] },
      };
  }
  return undefined;
}

function handlePatch(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now: number,
): LocalPlayResponse | undefined {
  if (request.path !== "/portal/me") return undefined;
  const body = (request.body ?? {}) as { teamName?: unknown };
  if (typeof body.teamName !== "string" || body.teamName.trim().length === 0) {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_team_name" } };
  }
  state.teamName = body.teamName.trim();
  return teamView(state, now);
}

/** A route handler either answers (sync or async) or declines by returning `undefined`. */
type MaybeHandled = Promise<LocalPlayResponse> | LocalPlayResponse | undefined;

function handlePost(
  request: LocalPlayRequest,
  state: LocalPlayState,
  iso: string,
  now: number,
): MaybeHandled {
  if (request.path === "/portal/me/submit-flag") {
    return submitFlag(request, state, iso);
  }
  const workbench = WORKBENCH_RE.exec(request.path);
  if (workbench) return handleWorkbench(request, workbench, state);
  const consoleHandoff = handleConsoleHandoffPost(request, state, now);
  if (consoleHandoff) return consoleHandoff;
  const terminalHandoff = handleTerminalHandoffPost(request, state, now);
  if (terminalHandoff) return terminalHandoff;
  const lifecycle = handleLifecyclePost(request.path, state, now);
  if (lifecycle) return lifecycle;
  const simulator = handleSimulatorPost(request, state);
  if (simulator) return simulator;
  const match = REVEAL_RE.exec(request.path);
  if (!match) return undefined;
  const problemId = decodePathSegment(match[1]);
  const hintId = decodePathSegment(match[2]);
  if (problemId === undefined || hintId === undefined) {
    // A malformed percent escape is just an unknown hint, not a 500.
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
  }
  return revealHint(problemId, hintId, state, iso);
}

const WORKBENCH_GET_ACTIONS = new Set<WorkbenchAction>(["config", "starter", "inspect"]);

/**
 * Proxy one allowlisted editor operation to a running container. The public route is
 * already protected by the server's `/portal/` bearer gate; this layer additionally
 * refuses unknown, stopped, simulated, and method-mismatched targets.
 */
async function handleWorkbench(
  request: LocalPlayRequest,
  match: RegExpExecArray,
  state: LocalPlayState,
): Promise<LocalPlayResponse> {
  const problemId = decodePathSegment(match[1]);
  const action = match[2] as WorkbenchAction;
  const runtime = problemId === undefined ? undefined : state.runtimes.get(problemId);
  if (!problemId || !runtime) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  }
  if (state.lifecycle.statusOf(problemId) !== "running") {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  const expectedMethod = WORKBENCH_GET_ACTIONS.has(action) ? "GET" : "POST";
  if (request.method !== expectedMethod) {
    return { status: StatusCodes.METHOD_NOT_ALLOWED, body: { error: "method_not_allowed" } };
  }
  try {
    const body = await state.workbench(runtime.problem.verifyUrl, action, request.body);
    return workbenchSuccess(action, problemId, body);
  } catch (error) {
    if (error instanceof WorkbenchClientError && error.code === "not_supported") {
      return { status: StatusCodes.NOT_FOUND, body: { error: "workbench_not_supported" } };
    }
    return {
      status: StatusCodes.BAD_GATEWAY,
      body: {
        error:
          error instanceof WorkbenchClientError && error.code === "invalid_response"
            ? "invalid_workbench_response"
            : "workbench_unavailable",
      },
    };
  }
}

function workbenchSuccess(
  action: WorkbenchAction,
  problemId: string,
  body: unknown,
): LocalPlayResponse {
  if (action === "config" && (body as { id?: unknown }).id !== problemId) {
    return { status: StatusCodes.BAD_GATEWAY, body: { error: "invalid_workbench_response" } };
  }
  return { status: StatusCodes.OK, body };
}

/**
 * Bearer guard shared by the handoff mints (console / terminal): both endpoints spend
 * the participant token on a normal authenticated request and exchange it for a ticket,
 * so they gate identically. 401 response when the token does not match, undefined when
 * the request may proceed.
 */
function participantAuthError(
  request: LocalPlayRequest,
  state: LocalPlayState,
): LocalPlayResponse | undefined {
  if (request.authorization !== `Bearer ${state.participantToken}`) {
    return { status: StatusCodes.UNAUTHORIZED, body: { error: "unauthorized" } };
  }
  return undefined;
}

/**
 * Mint a single-use handoff ticket. Issuing is the only writer of these maps, so the
 * sweep here is what keeps never-redeemed tickets from accumulating; redemption deletes
 * unconditionally on lookup.
 */
function mintHandoffTicket<Entry extends { readonly expiresAtMs: number }>(
  handoffs: Map<string, Entry>,
  entry: Entry,
  now: number,
): string {
  for (const [issued, handoff] of handoffs) {
    if (handoff.expiresAtMs <= now) handoffs.delete(issued);
  }
  const ticket = randomBytes(32).toString("base64url");
  handoffs.set(ticket, entry);
  return ticket;
}

function handleConsoleHandoffPost(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now: number,
): LocalPlayResponse | undefined {
  const match = CONSOLE_HANDOFF_RE.exec(request.path);
  if (!match) return undefined;
  const unauthorized = participantAuthError(request, state);
  if (unauthorized) return unauthorized;
  const resolved = resolveRunningSimulatedConsole(state, match[1]);
  if ("response" in resolved) return resolved.response;
  const { problemId, deployment } = resolved;
  const ticket = mintHandoffTicket(
    state.consoleHandoffs,
    {
      problemId,
      deploymentId: deployment.deploymentId,
      expiresAtMs: now + CONSOLE_HANDOFF_TTL_MS,
    },
    now,
  );
  return {
    status: StatusCodes.OK,
    body: {
      handoffPath: `portal/me/problems/${encodeURIComponent(problemId)}/console?${new URLSearchParams({ ticket })}`,
    },
    headers: { "cache-control": "no-store" },
  };
}

/**
 * [#2846] POST /portal/me/problems/:id/terminal-handoff — mint the one ticket the
 * terminal WebSocket upgrade will accept.
 *
 * A browser cannot set an Authorization header on a WebSocket handshake, so the
 * participant token is spent here, on a normal authenticated request, and exchanged for
 * a short-lived single-use ticket the upgrade can carry in its query string. Container
 * problems only: a simulated-cloud problem has no container to exec into.
 *
 * [#2850] The terminal is per-problem opt-in: only a problem whose metadata declares
 * `runtime.terminal` may mint a ticket. A shell reads whatever the target image holds,
 * so the default for every other problem — multi-service stacks, images carrying
 * author-only material — is no ticket, hence no upgrade, hence no shell.
 */
function handleTerminalHandoffPost(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now: number,
): LocalPlayResponse | undefined {
  const match = TERMINAL_HANDOFF_RE.exec(request.path);
  if (!match) return undefined;
  const unauthorized = participantAuthError(request, state);
  if (unauthorized) return unauthorized;
  const problemId = decodePathSegment(match[1]);
  const runtime = problemId === undefined ? undefined : state.runtimes.get(problemId);
  if (problemId === undefined || runtime === undefined) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  }
  if (!runtime.problem.terminal) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "terminal_not_supported" } };
  }
  if (state.lifecycle.statusOf(problemId) !== "running") {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  const ticket = mintHandoffTicket(
    state.terminalHandoffs,
    { problemId, expiresAtMs: now + TERMINAL_HANDOFF_TTL_MS },
    now,
  );
  return {
    status: StatusCodes.OK,
    body: { ticket, expiresInMs: TERMINAL_HANDOFF_TTL_MS },
    headers: { "cache-control": "no-store" },
  };
}

function handleLifecyclePost(
  path: string,
  state: LocalPlayState,
  now: number,
): Promise<LocalPlayResponse> | LocalPlayResponse | undefined {
  const start = START_RE.exec(path);
  if (start) {
    const problemId = decodePathSegment(start[1]);
    if (problemId === undefined) {
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
    }
    return startProblem(problemId, state, now);
  }
  const stop = STOP_RE.exec(path);
  if (stop) {
    const problemId = decodePathSegment(stop[1]);
    if (problemId === undefined) {
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
    }
    return stopProblem(problemId, state);
  }
  const reset = RESET_RE.exec(path);
  if (reset) {
    const problemId = decodePathSegment(reset[1]);
    if (problemId === undefined) {
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
    }
    if (!state.simulatedRuntimes.has(problemId)) {
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_simulated_problem" } };
    }
    return stopProblem(problemId, state)
      .then(async (stopped) => {
        if (stopped.status !== StatusCodes.OK) return stopped;
        return startProblem(problemId, state, now);
      })
      .catch(() => ({
        status: StatusCodes.BAD_GATEWAY,
        body: {
          error: "reset_failed",
          message: "Simulator problem failed to reset",
        },
      }));
  }
  const score = SCORE_RE.exec(path);
  if (score) {
    const problemId = decodePathSegment(score[1]);
    if (problemId === undefined) {
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
    }
    return scoreSimulatedProblem(problemId, state, now);
  }
  return undefined;
}

function handleSnapshotPost(
  snapshot: RegExpExecArray,
  state: LocalPlayState,
): Promise<LocalPlayResponse> | LocalPlayResponse {
  const problemId = decodePathSegment(snapshot[1]);
  const name = decodePathSegment(snapshot[2]);
  const action = snapshot[3];
  const runtime = problemId ? state.simulatedRuntimes.get(problemId) : undefined;
  if (!runtime || !state.simulator || !state.simulatorSnapshotDir) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_snapshot_target" } };
  }
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_snapshot_name" } };
  }
  if (state.lifecycle.statusOf(problemId) !== "running" || !runtime.deployment) {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  mkdirSync(state.simulatorSnapshotDir, { recursive: true, mode: 0o700 });
  const path = join(state.simulatorSnapshotDir, `${name}.json`);
  const operation =
    action === "export"
      ? state.simulator.exportSnapshot(problemId, path)
      : state.simulator.importSnapshot(problemId, path);
  return operation.then(() => ({
    status: StatusCodes.OK,
    body: { action, problemId, name },
  }));
}

function handleEndpointPost(
  endpoint: RegExpExecArray,
  body: unknown,
  state: LocalPlayState,
): LocalPlayResponse {
  const problemId = decodePathSegment(endpoint[1]);
  const slot = decodePathSegment(endpoint[2]);
  if (problemId === undefined || slot === undefined) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_slot" } };
  }
  return putSimulatorEndpoint(problemId, slot, body, state);
}

function handleDisruptionPost(
  disruption: RegExpExecArray,
  state: LocalPlayState,
): Promise<LocalPlayResponse> | LocalPlayResponse {
  const problemId = decodePathSegment(disruption[1]);
  const disruptionId = decodePathSegment(disruption[2]);
  const runtime = problemId ? state.simulatedRuntimes.get(problemId) : undefined;
  if (!runtime || !disruptionId || !state.simulator) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_disruption" } };
  }
  return state.simulator
    .fireDisruption(runtime.problem, disruptionId)
    .then((result) => ({ status: StatusCodes.OK, body: { result } }));
}

function handleSimulatorPost(
  request: LocalPlayRequest,
  state: LocalPlayState,
): Promise<LocalPlayResponse> | LocalPlayResponse | undefined {
  if (
    request.path.startsWith("/local/operator/") &&
    request.authorization !== `Bearer ${state.participantToken}`
  ) {
    return { status: StatusCodes.UNAUTHORIZED, body: { error: "unauthorized" } };
  }
  const snapshot = SNAPSHOT_RE.exec(request.path);
  if (snapshot) return handleSnapshotPost(snapshot, state);
  const endpoint = ENDPOINT_RE.exec(request.path);
  if (endpoint) return handleEndpointPost(endpoint, request.body, state);
  const disruption = DISRUPTION_RE.exec(request.path);
  if (disruption) return handleDisruptionPost(disruption, state);
  return undefined;
}

function simulatorEndpointView(
  slot: SimulatedProblemRuntime["contract"]["endpoints"][number],
  runtime: SimulatedProblemRuntime,
  outputs: Readonly<Record<string, string>>,
  state: LocalPlayState,
) {
  const rawDefault = simulatorOutput(outputs, slot.default.key);
  const defaultUrl = rawDefault
    ? resolveDefaultUrl(rawDefault, slot.default.appendPath)
    : undefined;
  const overrideUrl = runtime.overrides.get(slot.slot);
  const visibleDefaultUrl = defaultUrl ? state.browserText(defaultUrl) : undefined;
  const visibleOverrideUrl = overrideUrl ? state.browserText(overrideUrl) : undefined;
  return {
    slot: slot.slot,
    defaultKey: slot.default.key,
    overridable: slot.overridable,
    ...(slot.label ? { label: slot.label } : {}),
    ...(slot.description ? { description: slot.description } : {}),
    ...(visibleDefaultUrl ? { defaultUrl: visibleDefaultUrl } : {}),
    ...(visibleOverrideUrl ? { overrideUrl: visibleOverrideUrl } : {}),
    ...(visibleOverrideUrl || visibleDefaultUrl
      ? { effectiveUrl: visibleOverrideUrl ?? visibleDefaultUrl }
      : {}),
  };
}

function simulatorEndpoints(problemId: string, state: LocalPlayState): LocalPlayResponse {
  const runtime = state.simulatedRuntimes.get(problemId);
  if (!runtime) return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  if (runtime.contract.endpoints.length === 0) {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "no_endpoints" } };
  }
  const outputs = runtime.deployment
    ? participantSimulatorOutputs(runtime.problem, runtime.deployment.outputs)
    : {};
  return {
    status: StatusCodes.OK,
    body: {
      teamId: LOCAL_CONTEXT.teamId,
      endpoints: runtime.contract.endpoints.map((slot) =>
        simulatorEndpointView(slot, runtime, outputs, state),
      ),
    },
  };
}

function putSimulatorEndpoint(
  problemId: string,
  slotName: string,
  body: unknown,
  state: LocalPlayState,
): LocalPlayResponse {
  const runtime = state.simulatedRuntimes.get(problemId);
  if (!runtime) return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  const slot = runtime.contract.endpoints.find((candidate) => candidate.slot === slotName);
  if (!slot) return { status: StatusCodes.BAD_REQUEST, body: { error: "unknown_slot" } };
  if (!slot.overridable) {
    return { status: StatusCodes.CONFLICT, body: { error: "slot_not_overridable" } };
  }
  const urlValue =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { url?: unknown }).url
      : undefined;
  if (typeof urlValue !== "string") {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_url" } };
  }
  try {
    const url = parseLoopbackUrl(urlValue, "endpoint override");
    if (url.username || url.password) throw new Error("credentials are forbidden");
    runtime.overrides.set(slotName, url.toString());
  } catch {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_url" } };
  }
  return simulatorEndpoints(problemId, state);
}

function deleteSimulatorEndpoint(
  problemId: string,
  slotName: string,
  state: LocalPlayState,
): LocalPlayResponse {
  const runtime = state.simulatedRuntimes.get(problemId);
  if (!runtime) return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  if (!runtime.contract.endpoints.some((slot) => slot.slot === slotName)) {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "unknown_slot" } };
  }
  runtime.overrides.delete(slotName);
  return simulatorEndpoints(problemId, state);
}

function handleDelete(
  request: LocalPlayRequest,
  state: LocalPlayState,
): LocalPlayResponse | undefined {
  const endpoint = ENDPOINT_RE.exec(request.path);
  if (!endpoint) return undefined;
  const problemId = decodePathSegment(endpoint[1]);
  const slot = decodePathSegment(endpoint[2]);
  if (problemId === undefined || slot === undefined) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_slot" } };
  }
  return deleteSimulatorEndpoint(problemId, slot, state);
}

export async function handleLocalPlayRequest(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now = Date.now(),
): Promise<LocalPlayResponse> {
  const iso = new Date(now).toISOString();
  if (request.method === "GET") {
    const response = await handleGet(request, state, now);
    if (response) return response;
  }
  if (request.method === "PATCH") {
    const response = handlePatch(request, state, now);
    if (response) return response;
  }
  if (request.method === "POST") {
    const response = handlePost(request, state, iso, now);
    if (response) return response;
  }
  if (request.method === "DELETE") {
    const response = handleDelete(request, state);
    if (response) return response;
  }
  return { status: StatusCodes.NOT_FOUND, body: { error: "not_found" } };
}
