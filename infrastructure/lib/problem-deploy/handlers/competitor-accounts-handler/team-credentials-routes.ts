import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import {
  type AzureDeployCredential,
  deleteAzureCredential,
  getAzureCredential,
  putAzureCredential,
} from "../shared/azure-credential-store.js";
import {
  deleteGcpCredential,
  type GcpDeployCredential,
  getGcpCredential,
  putGcpCredential,
} from "../shared/gcp-credential-store.js";
import type { SakuraCredential } from "../shared/runtime/sakura-apprun-adapter.js";
import {
  deleteSakuraCredential,
  getSakuraCredential,
  putSakuraCredential,
} from "../shared/sakura-credential-store.js";
import type { SecureJsonStoreDeps } from "../shared/secure-json-store.js";

/**
 * [Issue #1413] per-team cloud credential onboarding routes。
 *
 * 非 AWS の問題 (sakura/azure/gcp) を deploy する前に、 TenantAdmin が per-team の認証情報を SSM SecureString
 * store ([[sakura-credential-store.ts]] / [[azure-credential-store.ts]] / [[gcp-credential-store.ts]]) に登録する
 * 経路。 deploy worker の `getCredential` がこの store を引く ([[adapter-dependencies.ts]])。 本 module は
 * provider 別の Zod 検証 + store 呼び出しだけを担い、 **secret は決して response に echo しない** (register は
 * `{registered:true}`、 status は `{registered:boolean}` のみ)。 register は Overwrite なので rotation 兼用。
 */

const SakuraCredentialSchema = z
  .object({ accessToken: z.string().min(1), accessTokenSecret: z.string().min(1) })
  .strict();

const AzureCredentialSchema = z
  .object({
    azureTenantId: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    subscriptionId: z.string().min(1),
    resourceGroup: z.string().min(1),
    location: z.string().min(1).optional(),
  })
  .strict();

const GcpCredentialSchema = z
  .object({
    wifAudience: z.string().min(1),
    serviceAccountEmail: z.string().min(1),
    projectId: z.string().min(1),
    location: z.string().min(1),
  })
  .strict();

export const TEAM_CREDENTIAL_PROVIDERS = ["sakura", "azure", "gcp"] as const;
export type TeamCredentialProvider = (typeof TEAM_CREDENTIAL_PROVIDERS)[number];

export function isTeamCredentialProvider(value: string): value is TeamCredentialProvider {
  return (TEAM_CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}

export interface TeamCredentialDeps {
  readonly shared: SecureJsonStoreDeps;
}

/**
 * Team credential route の結果型。 `status` を discriminant にした union で、 caller (index.ts) が
 * `c.json(result.body, result.status)` を cast 無しで型検査できるようにする。 secret は body に
 * 含めない (= register は `{registered:true}`、 status は `{registered:boolean}` のみ)。
 */
export type TeamCredentialRouteResult =
  | {
      readonly status: StatusCodes.CREATED;
      readonly body: {
        readonly registered: true;
        readonly provider: TeamCredentialProvider;
        readonly teamSlug: string;
      };
    }
  | {
      readonly status: StatusCodes.OK;
      readonly body: {
        readonly deleted: true;
        readonly provider: TeamCredentialProvider;
        readonly teamSlug: string;
      };
    }
  | {
      readonly status: StatusCodes.OK;
      readonly body: {
        readonly provider: TeamCredentialProvider;
        readonly teamSlug: string;
        readonly registered: boolean;
      };
    }
  | {
      readonly status: StatusCodes.BAD_REQUEST;
      readonly body: { readonly error: "validation_failed"; readonly issues: unknown };
    };

/**
 * provider の credential を登録 / 上書き (= register + rotation)。 secret は response に含めない。
 */
export async function handleRegisterTeamCredential(
  deps: TeamCredentialDeps,
  provider: TeamCredentialProvider,
  tenantId: string,
  teamSlug: string,
  rawBody: unknown,
): Promise<TeamCredentialRouteResult> {
  const store = deps.shared;
  if (provider === "sakura") {
    const parsed = SakuraCredentialSchema.safeParse(rawBody);
    if (!parsed.success) return validationFailed(parsed.error.issues);
    await putSakuraCredential(store, tenantId, teamSlug, parsed.data satisfies SakuraCredential);
  } else if (provider === "azure") {
    const parsed = AzureCredentialSchema.safeParse(rawBody);
    if (!parsed.success) return validationFailed(parsed.error.issues);
    await putAzureCredential(
      store,
      tenantId,
      teamSlug,
      parsed.data satisfies AzureDeployCredential,
    );
  } else {
    const parsed = GcpCredentialSchema.safeParse(rawBody);
    if (!parsed.success) return validationFailed(parsed.error.issues);
    await putGcpCredential(store, tenantId, teamSlug, parsed.data satisfies GcpDeployCredential);
  }
  return { status: StatusCodes.CREATED, body: { registered: true, provider, teamSlug } };
}

/** provider の credential を削除 (= revoke / teardown)。 不在でも idempotent に 200。 */
export async function handleDeleteTeamCredential(
  deps: TeamCredentialDeps,
  provider: TeamCredentialProvider,
  tenantId: string,
  teamSlug: string,
): Promise<TeamCredentialRouteResult> {
  const store = deps.shared;
  if (provider === "sakura") await deleteSakuraCredential(store, tenantId, teamSlug);
  else if (provider === "azure") await deleteAzureCredential(store, tenantId, teamSlug);
  else await deleteGcpCredential(store, tenantId, teamSlug);
  return { status: StatusCodes.OK, body: { deleted: true, provider, teamSlug } };
}

/**
 * provider の credential が登録済かを返す。 **secret / config は返さず** `{registered}` だけ
 * (= TenantAdmin が登録の有無を確認する用途、 値の漏洩を作らない)。
 */
export async function handleGetTeamCredentialStatus(
  deps: TeamCredentialDeps,
  provider: TeamCredentialProvider,
  tenantId: string,
  teamSlug: string,
): Promise<TeamCredentialRouteResult> {
  const store = deps.shared;
  const registered =
    provider === "sakura"
      ? (await getSakuraCredential(store, tenantId, teamSlug)) !== undefined
      : provider === "azure"
        ? (await getAzureCredential(store, tenantId, teamSlug)) !== undefined
        : (await getGcpCredential(store, tenantId, teamSlug)) !== undefined;
  return { status: StatusCodes.OK, body: { provider, teamSlug, registered } };
}

function validationFailed(issues: unknown): TeamCredentialRouteResult {
  return { status: StatusCodes.BAD_REQUEST, body: { error: "validation_failed", issues } };
}
