import type { ApiClient } from "./client";

/**
 * Competitor Accounts API client (Issue #459 / ADR-002 Phase 2.1)。
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
  /** 最後に ExternalId を rotate した時刻 (Issue #596 / ADR-002 Phase 3.1)。未 rotate なら undefined。 */
  rotatedAt?: string;
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

/**
 * `/admin/competitor-accounts/{awsAccountId}/rotate-external-id` の response (Issue #596 / Phase 3.1)。
 * Create と同じく `externalId` を 1 度きり露出する。`rotatedAt` は rotation 時刻 ISO 8601。
 */
export interface RotateExternalIdResponse extends CompetitorAccountSummary {
  externalId: string;
  tenkaCloudAccountId: string;
  rotatedAt: string;
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

/**
 * 既存 account に紐付く tenant の ExternalId を rotate する (Issue #596 / ADR-002 Phase 3.1)。
 * 新 ExternalId は response の `externalId` で 1 度だけ露出する。
 */
export async function rotateExternalId(
  api: ApiClient,
  awsAccountId: string,
): Promise<RotateExternalIdResponse> {
  return api.post<RotateExternalIdResponse>(
    `admin/competitor-accounts/${encodeURIComponent(awsAccountId)}/rotate-external-id`,
    {},
  );
}
