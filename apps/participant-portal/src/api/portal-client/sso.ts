import { portalFetch } from "./fetch";
import type { CliCredentialsView } from "./types";

/**
 * SSO Credentials 系 endpoints (= AWS Console federation + CLI/SDK 一時資格情報)。
 * どちらも 500 + error="assume_role_failed" を `PortalAssumeRoleError` (= stage / reason 付き)
 * に変換し、 UI が 「どちらの AssumeRole 段で落ちたか」 を競技者 / operator に案内できる。
 */

/**
 * SSO Credentials: AWS Console ワンクリック login URL を発行する API。
 * 競技者が click すると Lambda が STS AssumeRole + federation で SigninToken を
 * 発行し、URL を返す。frontend は window.open でその URL を開く (= 自前 AWS ログイン不要)。
 *
 * Issue #1197: 500 + assume_role_failed を `PortalAssumeRoleError` (= stage / reason 付き)
 * に変換する。 UI が 「どちらの AssumeRole 段で落ちたか」 を表示できる。
 */
export async function getConsoleSigninUrl(
  apiBaseUrl: string,
  teamLoginKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<string> {
  const data = (await portalFetch<{ loginUrl: string }>(
    apiBaseUrl,
    "portal/me/console-signin-url",
    teamLoginKey,
    { query: { jobId }, throwOn400: true, throwOnAssumeRoleFailed: true, signal },
  )) as { loginUrl: string };
  return data.loginUrl;
}

/**
 * Issue #1197: CLI / SDK 用一時資格情報。 backend は Console federation と同じ 2 段
 * AssumeRole (= CompetitorDeployRole → ParticipantViewerRole) を実行し、 federation
 * endpoint を呼ばずに credentials を返す。
 */
export async function getCliCredentials(
  apiBaseUrl: string,
  teamLoginKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<CliCredentialsView> {
  const data = (await portalFetch<{ credentials: CliCredentialsView }>(
    apiBaseUrl,
    "portal/me/cli-credentials",
    teamLoginKey,
    { query: { jobId }, throwOn400: true, throwOnAssumeRoleFailed: true, signal },
  )) as { credentials: CliCredentialsView };
  return data.credentials;
}
