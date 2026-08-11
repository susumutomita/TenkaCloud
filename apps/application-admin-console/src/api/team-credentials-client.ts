import type { ApiClient } from "./client";

/**
 * Issue #1413: per-team cloud credential onboarding API client。
 *
 * tenant API の `/admin/team-cloud-credentials/{provider}/{teamSlug}` を叩く。 tenantId は JWT claim から
 * backend が解決するので path / body には乗せない。 secret は register 時に送るだけで status では返らない
 * (= backend が echo しない)。
 */

export const TEAM_CREDENTIAL_PROVIDERS = ["sakura", "azure", "gcp"] as const;
export type TeamCredentialProvider = (typeof TEAM_CREDENTIAL_PROVIDERS)[number];

export interface TeamCredentialStatus {
  readonly provider: TeamCredentialProvider;
  readonly teamSlug: string;
  readonly registered: boolean;
}

export interface RegisterTeamCredentialResponse {
  readonly registered: boolean;
  readonly provider: TeamCredentialProvider;
  readonly teamSlug: string;
}

function credentialPath(provider: TeamCredentialProvider, teamSlug: string): string {
  return `admin/team-cloud-credentials/${encodeURIComponent(provider)}/${encodeURIComponent(teamSlug)}`;
}

/** provider の credential を登録 / 上書き (rotation 兼用)。 credential は provider 別の JSON。 */
export async function registerTeamCredential(
  api: ApiClient,
  provider: TeamCredentialProvider,
  teamSlug: string,
  credential: Readonly<Record<string, unknown>>,
): Promise<RegisterTeamCredentialResponse> {
  return api.put<RegisterTeamCredentialResponse>(credentialPath(provider, teamSlug), credential);
}

/** provider の credential を失効 (revoke / teardown)。 */
export async function revokeTeamCredential(
  api: ApiClient,
  provider: TeamCredentialProvider,
  teamSlug: string,
): Promise<void> {
  return api.del(credentialPath(provider, teamSlug));
}

/** provider の credential が登録済かを取得 (= secret は返らない、 registered boolean のみ)。 */
export async function getTeamCredentialStatus(
  api: ApiClient,
  provider: TeamCredentialProvider,
  teamSlug: string,
): Promise<TeamCredentialStatus> {
  return api.get<TeamCredentialStatus>(credentialPath(provider, teamSlug));
}
