import { StatusCodes } from "http-status-codes";

/**
 * Issue #1420: 参加者間 coordination の op 提出 / projection polling client。
 *
 * 専用 dispatcher Lambda が `coordinationApiUrl` を最小 IAM で host する。
 * portal slot (= 問題が同梱する UI) がこの client で op を送り、 自チーム向け projection を polling する。
 * backend の {@link CoordinationHandlerOutcome} に対応する discriminated union を返し、 caller (slot)
 * が `kind` で分岐する。 polling 方針は AGENTS.md (SSE 不使用) に従い、 呼び出し側 setInterval で行う。
 */
export type CoordinationOutcome =
  | { readonly kind: "ok"; readonly projection: unknown }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not_configured" }
  | { readonly kind: "unauthorized" };

function coordinationUrl(base: string, path: string): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(path, root).toString();
}

async function mapResponse(res: Response): Promise<CoordinationOutcome> {
  switch (res.status) {
    case StatusCodes.OK: {
      const body = (await res.json()) as { projection?: unknown };
      return { kind: "ok", projection: body.projection };
    }
    case StatusCodes.UNPROCESSABLE_ENTITY: {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { kind: "rejected", error: body.error ?? "rejected" };
    }
    case StatusCodes.CONFLICT:
      return { kind: "conflict" };
    case StatusCodes.SERVICE_UNAVAILABLE:
      return { kind: "unavailable" };
    case StatusCodes.UNAUTHORIZED:
      return { kind: "unauthorized" };
    default:
      // 404 (= coordination 未宣言) その他は not_configured に倒し、 slot は通常表示にフォールバック。
      return { kind: "not_configured" };
  }
}

/** team の op を提出し、 適用後の projection を返す (= write 経路)。 */
export async function submitCoordinationOp(
  coordinationApiUrl: string,
  teamLoginKey: string,
  op: unknown,
  signal?: AbortSignal,
): Promise<CoordinationOutcome> {
  const res = await fetch(coordinationUrl(coordinationApiUrl, "portal/me/coordination/op"), {
    method: "POST",
    headers: { authorization: `Bearer ${teamLoginKey}`, "content-type": "application/json" },
    body: JSON.stringify({ op }),
    signal,
  });
  return mapResponse(res);
}

/** 自チームの現在 projection を読む (= 書き込みなし、 polling 用)。 */
export async function getCoordinationProjection(
  coordinationApiUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<CoordinationOutcome> {
  const res = await fetch(
    coordinationUrl(coordinationApiUrl, "portal/me/coordination/projection"),
    { headers: { authorization: `Bearer ${teamLoginKey}` }, signal },
  );
  return mapResponse(res);
}
