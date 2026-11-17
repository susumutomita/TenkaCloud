import { normalizeSimulatorEndpointUrl } from "@tenkacloud/portal-contracts";
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

/** A one-use code for the Simulator's participant guest terminal (Simulator Battle only). */
export interface GuestTerminalHandoff {
  readonly code: string;
  readonly terminalUrl: string;
  readonly expiresAt: string;
}

/**
 * The host signs the Simulator terminal handoff with the participant's viewer role, never with
 * deploy credentials. The code is pasted manually into the Simulator page; it is not a login link.
 */
export async function getGuestTerminal(
  apiBaseUrl: string,
  teamLoginKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<GuestTerminalHandoff> {
  const data = (await portalFetch<GuestTerminalHandoff>(
    apiBaseUrl,
    "portal/me/guest-terminal",
    teamLoginKey,
    { query: { jobId }, throwOn400: true, throwOnAssumeRoleFailed: true, signal },
  )) as GuestTerminalHandoff;
  const url = new URL(data.terminalUrl);
  // Only the local Simulator's own terminal page, never another origin.
  if (
    `${normalizeSimulatorEndpointUrl(url.origin)}/_simulator/terminal` !== data.terminalUrl ||
    !/^[A-Za-z0-9_-]{64}$/u.test(data.code) ||
    Number.isNaN(Date.parse(data.expiresAt))
  )
    throw new Error("The host returned an invalid guest terminal handoff.");
  return data;
}
