import type { ApiClient } from "./client-contract";

/**
 * Issue #459: mandatory ExternalId を使う cross-account Competitor Accounts API client。
 *
 * 既存の `/admin/competitor-accounts*` wire contract を使う。
 * 現行クラウドは単独開催の registry を持ち、frontend から tenant selector は送らない。
 */

export interface SimulatorAuthority {
  authorityId: string;
  generation: number;
}
export interface SimulatorAuthorityInfo extends SimulatorAuthority {
  region: string;
  awsAccountId: string;
  bootstrapRoleName: string;
}
export function competitorAccountKey(account: {
  awsAccountId: string;
  simulatorAuthority?: SimulatorAuthority;
}): string {
  const binding = account.simulatorAuthority;
  return binding
    ? `sim:${binding.authorityId}:${binding.generation}:${account.awsAccountId}`
    : account.awsAccountId;
}
function authorityQuery(binding?: SimulatorAuthority): string {
  return binding
    ? `?${new URLSearchParams({ authorityId: binding.authorityId, generation: String(binding.generation) })}`
    : "";
}

/** Explicit local Simulator setup; never use real-AWS bootstrap links for this mode. */
export interface SimulatorConnectionInfo {
  endpoint: string;
  awsAccountId: string;
  bootstrapRoleName: string;
  region?: string;
}

export interface CompetitorAccountSummary {
  simulatorAuthority?: SimulatorAuthority;
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
  simulatorAuthority?: SimulatorAuthority;
  awsAccountId: string;
  region?: string;
  competitorRoleName?: string;
  alias?: string;
}

export interface CreateCompetitorAccountResponse extends CompetitorAccountSummary {
  simulator?: SimulatorConnectionInfo;
  /** 競技者に **1 度だけ** 露出する secret。`competitor-bootstrap.yaml` の Parameter に渡す。 */
  externalId?: string;
  /** 競技者に伝える TenkaCloud 側の AWS Account ID (CFn Parameter として要る)。 */
  tenkaCloudAccountId: string;
}

/** 一括登録 1 行。 `region` / `competitorRoleName` は `defaults` で代表させられる。 */
export interface BulkCompetitorAccountEntry {
  simulatorAuthority?: SimulatorAuthority;
  awsAccountId: string;
  region?: string;
  competitorRoleName?: string;
  alias?: string;
}

export interface BulkCreateCompetitorAccountsRequest {
  defaults?: {
    region?: string;
    competitorRoleName?: string;
  };
  accounts: readonly BulkCompetitorAccountEntry[];
}

export type BulkCompetitorAccountOutcome = "created" | "duplicate" | "invalid" | "failed";

export interface BulkCompetitorAccountResult {
  simulatorAuthority?: SimulatorAuthority;
  awsAccountId: string;
  outcome: BulkCompetitorAccountOutcome;
  /** `created` 以外のときだけ入る、 その行が通らなかった理由。 */
  message?: string;
}

export interface BulkCreateCompetitorAccountsResponse {
  simulator?: SimulatorConnectionInfo;
  results: readonly BulkCompetitorAccountResult[];
  created: number;
  duplicate: number;
  invalid: number;
  failed: number;
  /** 1 件でも作成できたときだけ返る (= 全行 duplicate なら配る bootstrap が無い)。 */
  externalId?: string;
  tenkaCloudAccountId: string;
}

export interface ListCompetitorAccountsResponse {
  authorities?: readonly SimulatorAuthorityInfo[];
  simulator?: SimulatorConnectionInfo;
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

/**
 * 複数 account の一括登録。 **部分的な成功が正常系**で、 1 行の失敗は他の行に影響しない
 * (= HTTP 200 + 行ごとの outcome)。 呼び出し側は `results` を表示する責任がある。
 */
export async function bulkCreateCompetitorAccounts(
  api: ApiClient,
  body: BulkCreateCompetitorAccountsRequest,
): Promise<BulkCreateCompetitorAccountsResponse> {
  return api.post<BulkCreateCompetitorAccountsResponse>("admin/competitor-accounts/bulk", body);
}

export async function verifyCompetitorAccount(
  api: ApiClient,
  awsAccountId: string,
  binding?: SimulatorAuthority,
): Promise<CompetitorAccountSummary> {
  return api.post<CompetitorAccountSummary>(
    `admin/competitor-accounts/${encodeURIComponent(awsAccountId)}/verify${authorityQuery(binding)}`,
    {},
  );
}

export async function deleteCompetitorAccount(
  api: ApiClient,
  awsAccountId: string,
  binding?: SimulatorAuthority,
): Promise<void> {
  return api.del(
    `admin/competitor-accounts/${encodeURIComponent(awsAccountId)}${authorityQuery(binding)}`,
  );
}
