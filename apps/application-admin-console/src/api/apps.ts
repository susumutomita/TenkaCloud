import type { ApiClient } from "./client";

/**
 * テナント内に公開されたアプリ (#40-d / #64)。AppsApiHandler が返す shape を反映。
 * status は "pending" (#40-b の旧インライン版互換) または "active" (#40-c の本実装) が入る。
 */
export interface App {
  tenantId: string;
  appId: string;
  name: string;
  upstreamUrl: string;
  status: "pending" | "active" | string;
  functionUrl?: string;
  functionArn?: string;
  functionName?: string;
  authProvider?: "Cognito" | "CognitoSamlEntraBroker";
  /** auth-proxy が JWT email の domain を照合する allowlist。空配列 = 全拒否。 */
  allowedEmailDomains?: string[];
  brokerEntra?: {
    providerName?: string;
    enterpriseApplicationDisplayName?: string;
    applicationObjectId?: string;
    appId?: string;
    servicePrincipalId?: string;
    invitedUsers?: Array<{ email: string; status: string; userId?: string }>;
  };
  createdAt?: string;
}

export interface CreateAppRequest {
  name: string;
  upstreamUrl: string;
  /**
   * このアプリへのアクセスを許可するメールドメイン (必須、最低 1 つ)。
   * 認証は通っても auth-proxy がここの domain と JWT email を照合し、
   * 不一致なら 403 を返す。
   */
  allowedEmailDomains: string[];
  guestEmails?: string[];
}

/** 自テナントの登録アプリ一覧を取得する。 */
export async function listApps(api: ApiClient): Promise<App[]> {
  const res = await api.get<{ apps?: App[] } | App[]>("apps");
  return Array.isArray(res) ? res : (res.apps ?? []);
}

/**
 * アプリを公開する (POST /apps)。backend Lambda が per-app auth-proxy Lambda を
 * 動的作成して Function URL を払い出し、Cognito callback URL にも追加する。
 */
export async function createApp(api: ApiClient, req: CreateAppRequest): Promise<App> {
  return await api.post<App>("apps", req);
}

/** 公開を取り下げる (DELETE /apps/{appId})。 */
export async function deleteApp(api: ApiClient, appId: string): Promise<void> {
  await api.del(`apps/${encodeURIComponent(appId)}`);
}
