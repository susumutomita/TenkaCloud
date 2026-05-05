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
}

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
