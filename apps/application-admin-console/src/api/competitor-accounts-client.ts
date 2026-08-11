import type { ApiClient } from "./client";

/**
 * Issue #459: mandatory ExternalId を使う cross-account Competitor Accounts API client。
 *
 * tenant API の `/admin/competitor-accounts*` routes を叩く。`tenantId` は JWT claim
 * から backend が解決するので、frontend では path に乗せない。
 */

export interface CompetitorAccountSummary {
  awsAccountId: string;
  region: string;
  competitorRoleName: string;
  alias?: string;
  verified: boolean;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCompetitorAccountRequest {
  awsAccountId: string;
  region?: string;
  competitorRoleName?: string;
  alias?: string;
}

export interface CreateCompetitorAccountResponse extends CompetitorAccountSummary {
  /** 競技者に **1 度だけ** 露出する secret。`competitor-bootstrap.yaml` の Parameter に渡す。 */
  externalId: string;
  /** 競技者に伝える TenkaCloud 側の AWS Account ID (CFn Parameter として要る)。 */
  tenkaCloudAccountId: string;
}

export interface ListCompetitorAccountsResponse {
  items: readonly CompetitorAccountSummary[];
}

export async function listCompetitorAccounts(
  api: ApiClient,
): Promise<ListCompetitorAccountsResponse> {
  return api.get<ListCompetitorAccountsResponse>("admin/competitor-accounts");
}

export async function createCompetitorAccount(
  api: ApiClient,
  body: CreateCompetitorAccountRequest,
): Promise<CreateCompetitorAccountResponse> {
  return api.post<CreateCompetitorAccountResponse>("admin/competitor-accounts", body);
}

export async function verifyCompetitorAccount(
  api: ApiClient,
  awsAccountId: string,
): Promise<CompetitorAccountSummary> {
  return api.post<CompetitorAccountSummary>(
    `admin/competitor-accounts/${encodeURIComponent(awsAccountId)}/verify`,
    {},
  );
}

export async function deleteCompetitorAccount(api: ApiClient, awsAccountId: string): Promise<void> {
  return api.del(`admin/competitor-accounts/${encodeURIComponent(awsAccountId)}`);
}
