import { PortalNetworkError } from "./errors";
import { portalFetch } from "./fetch";

/**
 * [#2846] local-play container terminal。 `ProblemRuntimeKind === "docker"` の問題だけが
 * 対象で、 TTY 無しの `/bin/sh` に 1 行単位で input/output を中継する。 AWS mode には存在しない
 * endpoint。backend は local-play の単一長期プロセス内でのみ WebSocket を実装する
 * (`scripts/local-play/problem-terminal.ts` 参照)。
 *
 * `issueProblemConsoleHandoff` (simulated-cloud の認証 console handoff) と同じ 2 段構え:
 *   1. `POST .../terminal-handoff` (Bearer team key) で一度きりの ticket を発行する。
 *   2. その ticket を query string に載せて WebSocket を張る (= bearer を WS URL に直接
 *      載せない。 ticket は短命 + one-time なので流出しても teamLoginKey ほどの被害にならない)。
 */

interface TerminalHandoffResponse {
  readonly ticket: string;
  readonly expiresInMs: number;
}

/**
 * `POST /portal/me/problems/{problemId}/terminal-handoff`。 200 `{ticket, expiresInMs}` /
 * 404 `{error:"unknown_problem"}` / 409 `{error:"not_running"}` (= container が running
 * でない — `PortalValidationError("not_running")` として throw され、 caller が
 * 「起動してから接続してください」 文言に変換する)。
 *
 * expiresInMs は呼び出し側 (UI) が使わない — ticket は発行直後に WebSocket handshake へ
 * そのまま渡すだけで、 期限切れは接続失敗 (WS close) として自然に観測できるため。
 */
export async function issueProblemTerminalHandoff(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = (await portalFetch<TerminalHandoffResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/terminal-handoff`,
    teamLoginKey,
    {
      method: "POST",
      // Issue #2846: 409 not_running を PortalValidationError に変換する (= throwConflictError
      // の generic fallback 経路。 scoring gate / hint_out_of_order / prerequisite の
      // どれでもない error code はそのまま `PortalValidationError(body.error)` になる)。
      throwOn409: true,
      signal,
    },
  )) as TerminalHandoffResponse;
  if (!response.ticket) {
    // 契約違反 (= backend が ticket 抜きで 200 を返した) を silent に通さない。
    throw new PortalNetworkError(502, "invalid_terminal_handoff");
  }
  return response.ticket;
}

/**
 * `{apiBaseUrl の http→ws, https→wss}/portal/me/problems/{problemId}/terminal?ticket={ticket}`。
 * `issueProblemConsoleHandoff` の base URL 組み立て (末尾 `/` 補完 → `new URL`) と同じ流儀。
 */
export function problemTerminalUrl(apiBaseUrl: string, problemId: string, ticket: string): string {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`portal/me/problems/${encodeURIComponent(problemId)}/terminal`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}
