export type DeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED";

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "COMPLETE",
  "FAILED",
  "DELETED",
]);

export interface ParticipantScoringInfo {
  readonly kind: "flag" | "uptime";
  /** flag 形式での 1 提出あたりの獲得点。 */
  readonly points?: number;
  /** uptime 形式での 1 回成功あたりの獲得点。 */
  readonly pointsPerSuccess?: number;
  readonly hints?: readonly string[];
  /** flag 形式で既に正解済みなら true (= 再提出は加点されない)。 */
  readonly flagSubmitted?: boolean;
}

export interface ParticipantView {
  readonly jobId: string;
  readonly problemId: string;
  /** `displayTeamName ?? <operator slug>` の最終表示名 */
  readonly teamName: string;
  /** 競技者が自分でチーム名を設定したか。false なら setup 画面を出す。 */
  readonly teamNameSetByCompetitor: boolean;
  readonly region: string;
  readonly status: DeploymentStatus;
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
  readonly expiresAt: number;
  /** チーム累計スコア (deploy 単位)。 */
  readonly score: number;
  readonly lastScoredAt?: string;
  readonly lastResult?: "ok" | "fail";
  readonly scoring?: ParticipantScoringInfo;
}

export type SubmitFlagOutcome =
  | { kind: "ok"; scoreDelta: number; totalScore: number }
  | { kind: "already_scored"; totalScore: number }
  | { kind: "wrong" };

export class PortalValidationError extends Error {
  constructor(public readonly errorCode: string) {
    super("入力値が不正です。");
    this.name = "PortalValidationError";
  }
}

export class PortalAuthError extends Error {
  constructor() {
    super("チームログインキーが無効か、デプロイが既に削除されています。");
    this.name = "PortalAuthError";
  }
}

export class PortalNetworkError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Portal API ${status}: ${body || "unknown"}`);
    this.name = "PortalNetworkError";
  }
}

/**
 * `GET /portal/me` を `Authorization: Bearer <teamLoginKey>` で呼び、
 * `ParticipantView` を返す。401 は `PortalAuthError`、それ以外の HTTP error は
 * `PortalNetworkError`。Lambda 側 (PR-H2) と shape を一致させる。
 */
function buildPortalUrl(apiBaseUrl: string, path: string): URL {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  return new URL(path, base);
}

export async function getPortalMe(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<ParticipantView> {
  const res = await fetch(buildPortalUrl(apiBaseUrl, "portal/me"), {
    method: "GET",
    headers: { authorization: `Bearer ${teamLoginKey}` },
    signal,
  });
  if (res.status === 401) throw new PortalAuthError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PortalNetworkError(res.status, body);
  }
  return (await res.json()) as ParticipantView;
}

/**
 * 競技者の表示用チーム名を更新する。`PATCH /portal/me { teamName }`。
 *  - 200: 更新成功、最新の `ParticipantView` を返す
 *  - 400: バリデーション失敗 → `PortalValidationError`
 *  - 401: bearer 失効 (削除済等) → `PortalAuthError`
 *  - その他 → `PortalNetworkError`
 */
export async function updateTeamName(
  apiBaseUrl: string,
  teamLoginKey: string,
  teamName: string,
  signal?: AbortSignal,
): Promise<ParticipantView> {
  const res = await fetch(buildPortalUrl(apiBaseUrl, "portal/me"), {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${teamLoginKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ teamName }),
    signal,
  });
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PortalValidationError(body.error ?? "invalid_team_name");
  }
  if (res.status === 401) throw new PortalAuthError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PortalNetworkError(res.status, body);
  }
  return (await res.json()) as ParticipantView;
}

/**
 * Flag を提出する。`POST /portal/me/submit-flag { flag }`.
 *  - 200 { kind: "ok" | "already_scored" | "wrong" }: 提出受理 (採点結果は kind で分岐)
 *  - 400 not_flag_problem / no_outputs / invalid_flag → `PortalValidationError`
 *  - 401 bearer 失効 → `PortalAuthError`
 */
export async function submitFlag(
  apiBaseUrl: string,
  teamLoginKey: string,
  flag: string,
  signal?: AbortSignal,
): Promise<SubmitFlagOutcome> {
  const res = await fetch(buildPortalUrl(apiBaseUrl, "portal/me/submit-flag"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${teamLoginKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ flag }),
    signal,
  });
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PortalValidationError(body.error ?? "invalid_flag");
  }
  if (res.status === 401) throw new PortalAuthError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PortalNetworkError(res.status, body);
  }
  return (await res.json()) as SubmitFlagOutcome;
}
