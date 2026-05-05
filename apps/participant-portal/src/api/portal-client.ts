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
  readonly teamName: string;
  readonly region: string;
  readonly status: DeploymentStatus;
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
  readonly expiresAt: number;
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
export async function getPortalMe(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<ParticipantView> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL("portal/me", base);
  const res = await fetch(url, {
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
