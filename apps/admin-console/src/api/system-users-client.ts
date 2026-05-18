import { StatusCodes } from "http-status-codes";
import type { AppConfig } from "../config";

/**
 * Issue #949 (ADR-020 Phase C): SystemAdmin Console から ControlPlane UserPool の
 * SystemAdmin / SystemAuditor user を CRUD する client。 admin-insight Lambda の
 * `/admin/insight/system-users` route 群を叩く (= 既存 `fetchTenantsInsightSummary` と同じ
 * base URL: `config.adminInsightApiUrl`)。
 *
 * `config.adminInsightApiUrl` 未配線 (= phase 2 deploy 前 / dev) なら client は null を返す。
 * caller (SystemUsersPage) は null を見て「未配線」 alert を表示する。
 */

export const SYSTEM_ROLES = ["SystemAdmin", "SystemAuditor"] as const;
export type SystemUserRole = (typeof SYSTEM_ROLES)[number];

export interface SystemUserSummary {
  readonly username: string;
  readonly email?: string;
  readonly enabled?: boolean;
  readonly status?: string;
  readonly createdAt?: string;
  readonly groups: readonly SystemUserRole[];
}

export interface SystemUsersClient {
  list(): Promise<SystemUserSummary[]>;
  invite(input: { email: string; role: SystemUserRole }): Promise<SystemUserSummary>;
  changeRole(username: string, role: SystemUserRole): Promise<void>;
  remove(username: string): Promise<void>;
}

export class SystemUsersApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | undefined,
    public readonly detail: unknown,
  ) {
    super(`SystemUsers API ${status}: ${errorCode ?? "unknown_error"}`);
    this.name = "SystemUsersApiError";
  }
}

export function createSystemUsersClient(
  config: AppConfig,
  idToken: string,
): SystemUsersClient | null {
  if (!config.adminInsightApiUrl) {
    return null;
  }
  const base = config.adminInsightApiUrl.endsWith("/")
    ? config.adminInsightApiUrl
    : `${config.adminInsightApiUrl}/`;

  const request = async (path: string, init: RequestInit = {}): Promise<Response | undefined> => {
    const url = new URL(path.replace(/^\//, ""), base);
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${idToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      let errorCode: string | undefined;
      let detail: unknown;
      try {
        const body = await res.json();
        detail = body;
        if (typeof body === "object" && body !== null && "error" in body) {
          errorCode = String((body as { error: unknown }).error);
        }
      } catch {
        // body parse 失敗時は detail を text で残す
        try {
          detail = await res.text();
        } catch {
          /* noop */
        }
      }
      throw new SystemUsersApiError(res.status, errorCode, detail);
    }
    return res;
  };

  return {
    async list() {
      const res = await request("admin/insight/system-users");
      if (!res) return [];
      const body = (await res.json()) as { items?: SystemUserSummary[] };
      return body.items ?? [];
    },
    async invite(input) {
      const res = await request("admin/insight/system-users", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!res) throw new Error("invite returned undefined response");
      return (await res.json()) as SystemUserSummary;
    },
    async changeRole(username, role) {
      await request(`admin/insight/system-users/${encodeURIComponent(username)}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
    },
    async remove(username) {
      await request(`admin/insight/system-users/${encodeURIComponent(username)}`, {
        method: "DELETE",
      });
    },
  };
}

/**
 * SystemUsersApiError を human-readable な message + i18n key にマップするヘルパ。
 * caller (UI) は本 helper を経由して 「あなたの role では…」 「最後の SystemAdmin は削除できません」
 * 等の親切なエラーを表示できる。
 */
export function describeSystemUsersError(err: SystemUsersApiError): {
  i18nKey: string;
  fallback: string;
} {
  switch (err.status) {
    case StatusCodes.FORBIDDEN:
      return { i18nKey: "system_users.error.forbidden", fallback: "SystemAdmin role が必要です" };
    case StatusCodes.CONFLICT:
      if (err.errorCode === "cannot_delete_self") {
        return {
          i18nKey: "system_users.error.cannot_delete_self",
          fallback: "lock-out 防止のため自分自身は削除できません",
        };
      }
      if (err.errorCode === "cannot_demote_self") {
        return {
          i18nKey: "system_users.error.cannot_demote_self",
          fallback: "lock-out 防止のため自分自身を降格できません",
        };
      }
      if (err.errorCode === "duplicate_user") {
        return {
          i18nKey: "system_users.error.duplicate",
          fallback: "同 email の user が既に存在します",
        };
      }
      return { i18nKey: "system_users.error.conflict", fallback: "競合が発生しました" };
    case StatusCodes.SERVICE_UNAVAILABLE:
      return {
        i18nKey: "system_users.error.unconfigured",
        fallback:
          "AdminInsight stack に ControlPlane UserPool が配線されていません (= deploy chain の更新が必要)",
      };
    case StatusCodes.NOT_FOUND:
      return {
        i18nKey: "system_users.error.not_found",
        fallback: "user が見つかりません",
      };
    default:
      return {
        i18nKey: "system_users.error.generic",
        fallback: `エラーが発生しました (${err.status})`,
      };
  }
}
