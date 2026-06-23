/**
 * Issue #1975: local self-paced Participant API の純ルーター。
 *
 * participant-portal が backend mode で叩く `/portal/*` 契約を、 local catalog + in-memory
 * state から組み立てて返す。 fixed local context: tenantId / eventId / teamId / participantId
 * = "local"。 副作用は state mutation のみ (= http / fs から切り離して 100% unit test 可能)。
 *
 * local mode の方針 (#1975 非目標): 認証・不正防止・隠しテスト秘匿は行わない。 bearer token は
 * 検証せず (= 任意キーで login 成立)、 hint content は即時公開、 flag は決定的な練習用 flag。
 */

import { type LocalCatalogProblem, localPracticeFlag } from "./catalog.ts";

export const LOCAL_CONTEXT = {
  tenantId: "local",
  eventId: "local",
  teamId: "local",
  participantId: "local",
} as const;

export interface LocalScoreEvent {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "flag" | "flag-wrong" | "hint";
  readonly points: number;
  readonly result: "ok" | "wrong";
  readonly occurredAt: string;
}

export interface LocalState {
  teamName: string;
  readonly solved: Set<string>;
  readonly revealed: Set<string>;
  readonly wrongCounts: Map<string, number>;
  readonly scoreEvents: LocalScoreEvent[];
  score: number;
}

export function createLocalState(teamName = "Local Player"): LocalState {
  return {
    teamName,
    solved: new Set(),
    revealed: new Set(),
    wrongCounts: new Map(),
    scoreEvents: [],
    score: 0,
  };
}

export interface LocalRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface LocalResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface LocalApiContext {
  readonly catalog: readonly LocalCatalogProblem[];
  readonly state: LocalState;
  /** epoch ms (テスト決定性のため注入)。 */
  readonly now: number;
}

const jobIdOf = (problemId: string) => `local-${problemId}`;
const hintKey = (problemId: string, hintId: string) => `${problemId}::${hintId}`;

function hintViews(problem: LocalCatalogProblem, ctx: LocalApiContext, iso: string) {
  return problem.hints.map((h) => {
    const revealed = ctx.state.revealed.has(hintKey(problem.problemId, h.id));
    return {
      id: h.id,
      penalty: h.penalty,
      revealed,
      ...(revealed ? { content: h.content, revealedAt: iso } : {}),
    };
  });
}

function problemView(problem: LocalCatalogProblem, ctx: LocalApiContext, iso: string) {
  const solved = ctx.state.solved.has(problem.problemId);
  return {
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    region: "local",
    awsAccountId: "000000000000",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: ctx.now + 365 * 24 * 60 * 60 * 1000,
    score: solved ? problem.points : 0,
    lastResult: solved ? ("ok" as const) : undefined,
    scoring: {
      kind: problem.scoringKind,
      points: problem.points,
      flagSubmitted: solved,
      hints: hintViews(problem, ctx, iso),
    },
    deployLog: { cursor: "", entries: [] },
    createdAt: iso,
  };
}

function teamView(ctx: LocalApiContext, iso: string): LocalResponse {
  return {
    status: 200,
    body: {
      team: {
        teamName: ctx.state.teamName,
        teamNameSetByCompetitor: true,
        eventId: LOCAL_CONTEXT.eventId,
        teamId: LOCAL_CONTEXT.teamId,
      },
      problems: ctx.catalog.map((p) => problemView(p, ctx, iso)),
      eventGate: { kind: "ok" },
    },
  };
}

function leaderboard(ctx: LocalApiContext): LocalResponse {
  return {
    status: 200,
    body: {
      eventId: LOCAL_CONTEXT.eventId,
      entries: [
        {
          rank: 1,
          teamId: LOCAL_CONTEXT.teamId,
          teamName: ctx.state.teamName,
          score: ctx.state.score,
          completedProblems: ctx.state.solved.size,
          totalProblems: ctx.catalog.length,
          isMyTeam: true,
        },
      ],
      scoreboardFrozen: false,
    },
  };
}

/** POST /portal/me/submit-flag の処理 (body は { problemId, flag })。 */
function handleSubmit(req: LocalRequest, ctx: LocalApiContext, iso: string): LocalResponse {
  const body = (req.body ?? {}) as { problemId?: unknown; flag?: unknown };
  const problemId = typeof body.problemId === "string" ? body.problemId : "";
  const flag = typeof body.flag === "string" ? body.flag : "";
  const problem = ctx.catalog.find((p) => p.problemId === problemId);
  if (!problem) return { status: 400, body: { error: "unknown_problem" } };
  if (ctx.state.solved.has(problemId)) {
    return { status: 200, body: { kind: "already_scored", totalScore: ctx.state.score } };
  }
  if (flag === localPracticeFlag(problemId)) {
    ctx.state.solved.add(problemId);
    ctx.state.score += problem.points;
    ctx.state.scoreEvents.unshift({
      jobId: jobIdOf(problemId),
      problemId,
      source: "flag",
      points: problem.points,
      result: "ok",
      occurredAt: iso,
    });
    return {
      status: 200,
      body: { kind: "ok", scoreDelta: problem.points, totalScore: ctx.state.score },
    };
  }
  const wrongCount = (ctx.state.wrongCounts.get(problemId) ?? 0) + 1;
  ctx.state.wrongCounts.set(problemId, wrongCount);
  ctx.state.scoreEvents.unshift({
    jobId: jobIdOf(problemId),
    problemId,
    source: "flag-wrong",
    points: 0,
    result: "wrong",
    occurredAt: iso,
  });
  return {
    status: 200,
    body: { kind: "wrong", scoreDelta: 0, totalScore: ctx.state.score, wrongCount },
  };
}

/** POST /portal/me/problems/:pid/hints/:hid/reveal の処理。 */
function handleReveal(
  problemId: string,
  hintId: string,
  ctx: LocalApiContext,
  iso: string,
): LocalResponse {
  const problem = ctx.catalog.find((p) => p.problemId === problemId);
  const hint = problem?.hints.find((h) => h.id === hintId);
  if (!problem || !hint) return { status: 404, body: { error: "unknown_hint" } };
  const key = hintKey(problemId, hintId);
  if (ctx.state.revealed.has(key)) {
    return {
      status: 200,
      body: {
        kind: "already_revealed",
        content: hint.content,
        penaltyApplied: 0,
        totalScore: ctx.state.score,
        revealedAt: iso,
      },
    };
  }
  ctx.state.revealed.add(key);
  ctx.state.score -= hint.penalty;
  if (hint.penalty > 0) {
    ctx.state.scoreEvents.unshift({
      jobId: jobIdOf(problemId),
      problemId,
      source: "hint",
      points: -hint.penalty,
      result: "ok",
      occurredAt: iso,
    });
  }
  return {
    status: 200,
    body: {
      kind: "ok",
      content: hint.content,
      penaltyApplied: hint.penalty,
      totalScore: ctx.state.score,
      revealedAt: iso,
    },
  };
}

function endpointsView(problemId: string, ctx: LocalApiContext): LocalResponse {
  const problem = ctx.catalog.find((p) => p.problemId === problemId);
  if (!problem) return { status: 404, body: { error: "unknown_problem" } };
  return {
    status: 200,
    body: {
      teamId: LOCAL_CONTEXT.teamId,
      endpoints: problem.endpoints.map((e) => ({
        slot: e.slot,
        overridable: e.overridable,
        defaultKey: e.defaultKey,
        ...(e.label !== undefined ? { label: e.label } : {}),
        ...(e.description !== undefined ? { description: e.description } : {}),
      })),
    },
  };
}

const REVEAL_RE = /^\/portal\/me\/problems\/([^/]+)\/hints\/([^/]+)\/reveal$/;
const ENDPOINTS_RE = /^\/portal\/me\/problems\/([^/]+)\/endpoints$/;

function leaderboardScoreEvents(ctx: LocalApiContext): LocalResponse {
  return {
    status: 200,
    body: {
      eventId: LOCAL_CONTEXT.eventId,
      teams: [
        {
          teamId: LOCAL_CONTEXT.teamId,
          teamName: ctx.state.teamName,
          isMyTeam: true,
          events: ctx.state.scoreEvents,
        },
      ],
    },
  };
}

/** method=GET の routing。 未マッチは undefined を返し caller が 404 にする。 */
function handleGet(
  req: LocalRequest,
  ctx: LocalApiContext,
  iso: string,
): LocalResponse | undefined {
  switch (req.path) {
    case "/healthz":
      return { status: 200, body: { status: "ok", mode: "local" } };
    case "/portal/me":
      return teamView(ctx, iso);
    case "/portal/me/score-events":
      return { status: 200, body: { entries: ctx.state.scoreEvents } };
    case "/portal/leaderboard":
      return leaderboard(ctx);
    case "/portal/leaderboard/score-events":
      return leaderboardScoreEvents(ctx);
    case "/portal/me/notifications":
      return { status: 200, body: { eventId: LOCAL_CONTEXT.eventId, items: [] } };
    case "/portal/me/deploy-logs":
      return { status: 200, body: { jobId: req.query.jobId ?? "", complete: true, entries: [] } };
    case "/portal/me/battle-attacks":
      return {
        status: 200,
        body: {
          jobId: req.query.jobId ?? "",
          problemId: "",
          sinceMin: Number(req.query.sinceMin ?? "0"),
          events: [],
        },
      };
  }
  const m = ENDPOINTS_RE.exec(req.path);
  return m ? endpointsView(decodeURIComponent(m[1]), ctx) : undefined;
}

/** method=POST の routing。 */
function handlePost(
  req: LocalRequest,
  ctx: LocalApiContext,
  iso: string,
): LocalResponse | undefined {
  if (req.path === "/portal/me/submit-flag") return handleSubmit(req, ctx, iso);
  const m = REVEAL_RE.exec(req.path);
  return m ? handleReveal(decodeURIComponent(m[1]), decodeURIComponent(m[2]), ctx, iso) : undefined;
}

/** method=PATCH の routing (team 名更新のみ)。 */
function handlePatch(
  req: LocalRequest,
  ctx: LocalApiContext,
  iso: string,
): LocalResponse | undefined {
  if (req.path !== "/portal/me") return undefined;
  const body = (req.body ?? {}) as { teamName?: unknown };
  if (typeof body.teamName === "string" && body.teamName.trim().length > 0) {
    ctx.state.teamName = body.teamName.trim();
  }
  return teamView(ctx, iso);
}

/** local Participant API の純ルーター。 副作用は ctx.state の mutation のみ。 */
export function handleLocalRequest(req: LocalRequest, ctx: LocalApiContext): LocalResponse {
  const iso = new Date(ctx.now).toISOString();
  let res: LocalResponse | undefined;
  if (req.method === "GET") res = handleGet(req, ctx, iso);
  else if (req.method === "POST") res = handlePost(req, ctx, iso);
  else if (req.method === "PATCH") res = handlePatch(req, ctx, iso);
  return res ?? { status: 404, body: { error: "not_found" } };
}
