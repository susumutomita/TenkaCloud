import { ApiError } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import type { ApiClient } from "./client-contract";
import type {
  EducationGraphLocale,
  EducationGraphResponse,
  EducationMaterialsResponse,
} from "./education-graph-client";
import type {
  BulkResult,
  CreateEventRequest,
  CreateEventResponse,
  EventDeploymentStatus,
  EventDeploymentSummary,
  EventDetail,
  EventListResponse,
  EventProblemTarget,
  EventStatus,
  EventSummary,
  RotateTeamLoginKeyResponse,
  TeamSummary,
} from "./events-client";

/**
 * Issue #1954 — no-AWS demo mode の fixture client (slice 1: 土台 / slice 2: 運営フロー)。
 *
 * `createApiClient` と同じ {@link ApiClient} interface を満たし、 実 AWS / backend / Cognito を
 * 一切叩かずに path + method で **module-level の可変 store** を操作する。 `useApiClient` が
 * `config.mode === "demo"` のとき差し込む (= 公開 demo URL で AWS なし・課金なしの運営フロー)。
 *
 * 対応経路: EventList (`GET events`) / EventDetail (`GET events/{id}`) / イベント作成
 * (`POST events`) / key rotation / bulk deploy (`POST events/{id}/deploy`)。 未対応は
 * `NOT_IMPLEMENTED`、存在しない event は `NOT_FOUND` を投げる (= 黙って空を返さない)。
 * 疑似デプロイの時間進行と participant 連携・ホスティングは後続 slice。
 */

interface DemoEventRecord {
  summary: EventSummary;
  teams: TeamSummary[];
  problems: EventProblemTarget[];
  deploymentsByProblem: Record<string, readonly EventDeploymentSummary[]>;
  /**
   * Issue #1954 slice 3: bulk deploy を撃った時刻 (ms)。 設定されているとデプロイ状態と
   * event status を**経過時間から導出**する (= ポーリングのたびに queued→deploying→ready が
   * 進む擬似デプロイ)。 未設定なら静的な `deploymentsByProblem` / `summary.status` を使う。
   */
  deployStartedAtMs?: number;
}

/** 疑似デプロイの所要モデル: queued (0〜) → deploying (2s〜) → ready (6s〜)。 */
const DEPLOY_PENDING_MS = 2000;
const DEPLOY_COMPLETE_MS = 6000;

function elapsedDeployStatus(elapsedMs: number): EventDeploymentStatus {
  if (elapsedMs < DEPLOY_PENDING_MS) return "PENDING";
  if (elapsedMs < DEPLOY_COMPLETE_MS) return "IN_PROGRESS";
  return "COMPLETE";
}

/** 一覧カード用のサマリ (時刻は決定的: テストを安定させる)。 */
const SEED_SUMMARIES: readonly EventSummary[] = [
  {
    eventId: "demo-event-ready",
    name: "Demo Cloud Cup — Spring",
    status: "READY",
    teamCount: 3,
    problemCount: 2,
    createdAt: "2026-05-20T09:00:00.000Z",
    updatedAt: "2026-05-20T10:00:00.000Z",
    expiresAt: 1779000000,
    startsAt: "2026-05-22T01:00:00.000Z",
    endsAt: "2026-05-22T04:00:00.000Z",
  },
  {
    eventId: "demo-event-deploying",
    name: "Demo Onboarding Day",
    status: "DEPLOYING",
    teamCount: 5,
    problemCount: 1,
    createdAt: "2026-05-21T09:00:00.000Z",
    updatedAt: "2026-05-21T09:30:00.000Z",
    expiresAt: 1779100000,
  },
  {
    eventId: "demo-event-ended",
    name: "Demo Annual Arena 2026",
    status: "ENDED",
    teamCount: 8,
    problemCount: 4,
    createdAt: "2026-04-01T09:00:00.000Z",
    updatedAt: "2026-04-01T13:00:00.000Z",
    expiresAt: 1775000000,
    scoringLocked: true,
    scoringLockedAt: "2026-04-01T13:00:00.000Z",
  },
  {
    eventId: "demo-event-draft",
    name: "Demo Draft (not deployed yet)",
    status: "DRAFT",
    teamCount: 2,
    problemCount: 1,
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-01T09:00:00.000Z",
    expiresAt: 1779300000,
  },
];

function buildDeployments(
  eventId: string,
  teams: readonly TeamSummary[],
  problems: readonly EventProblemTarget[],
  status: EventDeploymentStatus,
): Record<string, EventDeploymentSummary[]> {
  const byProblem: Record<string, EventDeploymentSummary[]> = {};
  for (const p of problems) {
    byProblem[p.problemId] = teams.map((t) => ({
      jobId: `demo-job-${eventId}-${p.problemId}-${t.teamId}`,
      teamId: t.teamId,
      status,
    }));
  }
  return byProblem;
}

/** サマリから詳細 (teams / problems / deployments) を合成する。 */
function synthRecord(summary: EventSummary): DemoEventRecord {
  const teams: TeamSummary[] = Array.from({ length: summary.teamCount }, (_, i) => ({
    teamId: `${summary.eventId}-team-${i + 1}`,
    internalSlug: `team-${i + 1}`,
    displayName: `Team ${i + 1}`,
  }));
  const problems: EventProblemTarget[] = Array.from({ length: summary.problemCount }, (_, i) => ({
    problemId: `demo-problem-${i + 1}`,
    defaultRegion: "ap-northeast-1",
  }));
  const depStatus: EventDeploymentStatus | null =
    summary.status === "READY" || summary.status === "ENDED"
      ? "COMPLETE"
      : summary.status === "DEPLOYING"
        ? "IN_PROGRESS"
        : null;
  return {
    summary,
    teams,
    problems,
    deploymentsByProblem: depStatus
      ? buildDeployments(summary.eventId, teams, problems, depStatus)
      : {},
  };
}

let events: DemoEventRecord[] = SEED_SUMMARIES.map(synthRecord);
let createdCounter = 0;
let rotationCounter = 0;

/** テスト間で store を初期状態に戻す。 */
export function resetDemoStore(): void {
  events = SEED_SUMMARIES.map(synthRecord);
  createdCounter = 0;
  rotationCounter = 0;
}

function findEvent(eventId: string): DemoEventRecord {
  const rec = events.find((e) => e.summary.eventId === eventId);
  if (!rec) throw new ApiError(StatusCodes.NOT_FOUND, `Demo event "${eventId}" not found.`);
  return rec;
}

/** deploy timer があれば status / deployments を経過時間から導出し、 無ければ静的値を返す。 */
function effectiveView(rec: DemoEventRecord): {
  status: EventStatus;
  deploymentsByProblem: Record<string, readonly EventDeploymentSummary[]>;
} {
  if (rec.deployStartedAtMs === undefined) {
    return { status: rec.summary.status, deploymentsByProblem: rec.deploymentsByProblem };
  }
  const depStatus = elapsedDeployStatus(Date.now() - rec.deployStartedAtMs);
  return {
    status: depStatus === "COMPLETE" ? "READY" : "DEPLOYING",
    deploymentsByProblem: buildDeployments(rec.summary.eventId, rec.teams, rec.problems, depStatus),
  };
}

function listEventsOp(): EventListResponse {
  return { items: events.map((e) => ({ ...e.summary, status: effectiveView(e).status })) };
}

function getEventDetailOp(eventId: string): EventDetail {
  const rec = findEvent(eventId);
  const view = effectiveView(rec);
  return {
    ...rec.summary,
    status: view.status,
    teams: rec.teams,
    problems: rec.problems,
    deploymentsByProblem: view.deploymentsByProblem,
  };
}

function createEventOp(body: CreateEventRequest): CreateEventResponse {
  createdCounter += 1;
  const eventId = `demo-event-created-${createdCounter}`;
  const createdAt = "2026-06-21T00:00:00.000Z";
  const expiresAt = 1779200000;
  const teams: TeamSummary[] = body.teams.map((t, i) => ({
    teamId: `${eventId}-team-${i + 1}`,
    internalSlug: t.internalSlug,
    displayName: t.internalSlug,
    awsAccountId: t.awsAccountId,
  }));
  const problems: EventProblemTarget[] = body.problems.map((p) => ({ ...p }));
  const summary: EventSummary = {
    eventId,
    name: body.name,
    status: "DRAFT",
    teamCount: teams.length,
    problemCount: problems.length,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  };
  events.unshift({ summary, teams, problems, deploymentsByProblem: {} });
  return {
    eventId,
    status: "DRAFT",
    createdAt,
    expiresAt,
    teams: teams.map((t, i) => ({
      teamId: t.teamId,
      internalSlug: t.internalSlug,
      teamLoginKey: `demo-key-${eventId}-${i + 1}`,
    })),
    problems,
  };
}

function bulkDeployOp(eventId: string): BulkResult {
  const rec = findEvent(eventId);
  // 静的に COMPLETE にせず、 撃った時刻だけ記録する。 以降の GET で経過時間から
  // queued → deploying → ready が導出され、 ポーリングで進捗が見える。
  rec.deployStartedAtMs = Date.now();
  rec.summary = { ...rec.summary, status: "DEPLOYING" };
  return { eventId, enqueued: rec.teams.length * rec.problems.length, skipped: 0 };
}

function rotateTeamLoginKeyOp(eventId: string, teamId: string): RotateTeamLoginKeyResponse {
  const rec = findEvent(eventId);
  if (!rec.teams.some((team) => team.teamId === teamId)) {
    throw new ApiError(StatusCodes.NOT_FOUND, `Demo team "${teamId}" not found.`);
  }
  rotationCounter += 1;
  return {
    kind: "ok",
    teamId,
    teamLoginKey: `demo-rotated-key-${eventId}-${rotationCounter}`,
    rotatedAt: "2026-06-21T00:00:00.000Z",
  };
}

function educationLocale(path: string): EducationGraphLocale {
  const value = new URL(path, "https://demo.tenkacloud.invalid").searchParams.get("locale");
  if (value === null) return "ja";
  if (value === "ja" || value === "en") return value;
  throw new ApiError(StatusCodes.BAD_REQUEST, `Unsupported education-graph locale "${value}".`);
}

function educationGraphOp(locale: EducationGraphLocale): EducationGraphResponse {
  const labels =
    locale === "ja"
      ? {
          problem: "管理者のメモ",
          objective: "オブジェクト単位の認可不備を発見できる",
          concept: "オブジェクト認可",
          assessment: "別ユーザーのデータへのアクセスを拒否できる",
        }
      : {
          problem: "The Admin's Note",
          objective: "Find broken object-level authorization",
          concept: "Object authorization",
          assessment: "Reject access to another user's data",
        };
  return {
    locale,
    nodes: [
      {
        id: "problem.api-idor-demo",
        type: "problem",
        label: labels.problem,
        problemId: "api-idor-demo",
      },
      {
        id: "lo.api-idor-demo.detect-object-authorization-gap",
        type: "learning_objective",
        label: labels.objective,
      },
      { id: "concept.authorization", type: "concept", label: labels.concept },
      {
        id: "assessment.api-idor-demo.identify-object-authorization-failure",
        type: "assessment_criterion",
        label: labels.assessment,
      },
      {
        id: "misconception.authenticated-means-authorized",
        type: "misconception",
        label:
          locale === "ja"
            ? "ログイン済みなら任意のオブジェクトへアクセスしてよいという誤解"
            : "The misconception that authentication grants access to every object",
      },
      {
        id: "audience.software-engineer",
        type: "audience",
        label: locale === "ja" ? "ソフトウェアエンジニア" : "Software engineer",
      },
    ],
    relations: [
      {
        type: "teaches",
        source: "problem.api-idor-demo",
        target: "lo.api-idor-demo.detect-object-authorization-gap",
      },
      {
        type: "covers",
        source: "problem.api-idor-demo",
        target: "concept.authorization",
      },
      {
        type: "requires",
        source: "lo.api-idor-demo.detect-object-authorization-gap",
        target: "concept.authorization",
      },
      {
        type: "assesses",
        source: "problem.api-idor-demo",
        target: "assessment.api-idor-demo.identify-object-authorization-failure",
      },
      {
        type: "related_to",
        source: "problem.api-idor-demo",
        target: "misconception.authenticated-means-authorized",
      },
      {
        type: "related_to",
        source: "problem.api-idor-demo",
        target: "audience.software-engineer",
      },
    ],
    problems: [{ id: "api-idor-demo", name: labels.problem, nodeId: "problem.api-idor-demo" }],
  };
}

function educationMaterialsOp(
  problemId: string,
  locale: EducationGraphLocale,
): EducationMaterialsResponse {
  if (problemId !== "api-idor-demo") {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      `Demo education-graph problem "${problemId}" not found.`,
    );
  }
  if (locale === "ja") {
    return {
      problemId,
      locale,
      materials: {
        videoScript: {
          title: "動画台本: 認証とオブジェクト認可",
          segments: [
            {
              heading: "導入",
              narration: "ログイン済みであることと、指定したデータを読めることは別の判断です。",
            },
            {
              heading: "確認",
              narration: "APIはリクエストされたオブジェクトの所有者を毎回検証します。",
            },
          ],
        },
        textLesson: {
          title: "解説: オブジェクト単位の認可",
          sections: [
            {
              heading: "根本原因",
              body: "有効なトークンだけを確認し、URLで指定されたプロフィールの所有者を確認していませんでした。",
            },
          ],
        },
        quiz: {
          title: "理解確認クイズ",
          questions: [
            {
              id: "authorization-check",
              prompt: "プロフィール取得APIがトークン検証に加えて確認すべきことは何ですか?",
              answer: "呼び出し元が対象プロフィールを読む権限を持つこと",
              explanation: "認証は利用者を特定し、認可は対象オブジェクトへの操作可否を判断します。",
            },
          ],
        },
      },
    };
  }
  return {
    problemId,
    locale,
    materials: {
      videoScript: {
        title: "Video script: Authentication and object authorization",
        segments: [
          {
            heading: "Opening",
            narration:
              "Being signed in and being allowed to read a specific record are separate decisions.",
          },
          {
            heading: "Check",
            narration: "The API verifies ownership of every requested object.",
          },
        ],
      },
      textLesson: {
        title: "Lesson: Object-level authorization",
        sections: [
          {
            heading: "Root cause",
            body: "The API validated the token but never checked who owned the profile named in the URL.",
          },
        ],
      },
      quiz: {
        title: "Knowledge check",
        questions: [
          {
            id: "authorization-check",
            prompt: "What must a profile API check in addition to validating the token?",
            answer: "That the caller may read the requested profile",
            explanation:
              "Authentication identifies the caller; authorization decides access to the object.",
          },
        ],
      },
    },
  };
}

/** leading slash と query string を落とした route key (例 `events?limit=50` → `events`)。 */
export function demoRouteKey(path: string): string {
  return path.replace(/^\//, "").split("?")[0];
}

export function createDemoApiClient(): ApiClient {
  const unsupported = (method: string, path: string): never => {
    throw new ApiError(
      StatusCodes.NOT_IMPLEMENTED,
      `Demo mode does not simulate "${method} ${demoRouteKey(path)}" yet — no real AWS is called.`,
    );
  };

  return {
    async get<T>(path: string): Promise<T> {
      const parts = demoRouteKey(path).split("/");
      if (parts[0] === "admin" && parts[1] === "education-graph" && parts.length === 2) {
        return educationGraphOp(educationLocale(path)) as unknown as T;
      }
      if (
        parts[0] === "admin" &&
        parts[1] === "education-graph" &&
        parts[2] === "problems" &&
        parts[4] === "materials" &&
        parts.length === 5
      ) {
        return educationMaterialsOp(
          decodeURIComponent(parts[3]),
          educationLocale(path),
        ) as unknown as T;
      }
      if (parts[0] === "events" && parts.length === 1) return listEventsOp() as unknown as T;
      if (parts[0] === "events" && parts.length === 2) {
        return getEventDetailOp(decodeURIComponent(parts[1])) as unknown as T;
      }
      return unsupported("GET", path);
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      const parts = demoRouteKey(path).split("/");
      if (parts[0] === "events" && parts.length === 1) {
        return createEventOp(body as CreateEventRequest) as unknown as T;
      }
      if (parts[0] === "events" && parts.length === 3 && parts[2] === "deploy") {
        return bulkDeployOp(decodeURIComponent(parts[1])) as unknown as T;
      }
      if (
        parts[0] === "events" &&
        parts[2] === "teams" &&
        parts[4] === "rotate-login-key" &&
        parts.length === 5
      ) {
        return rotateTeamLoginKeyOp(
          decodeURIComponent(parts[1]),
          decodeURIComponent(parts[3]),
        ) as unknown as T;
      }
      return unsupported("POST", path);
    },
    async put<T>(path: string): Promise<T> {
      return unsupported("PUT", path);
    },
    async patch<T>(path: string): Promise<T> {
      return unsupported("PATCH", path);
    },
    async del(path: string): Promise<void> {
      unsupported("DELETE", path);
    },
    async delJson<T>(path: string): Promise<T> {
      return unsupported("DELETE", path);
    },
  };
}
