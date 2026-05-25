import { TenantsApi } from "../api/tenants.ts";
import { resolveApiBase } from "../config/api-urls.ts";
import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { formatOutput, parseFormat } from "../output/format.ts";
import { parseFlags, requireFlag, requirePositional } from "./args.ts";

/**
 * Issue #1305: tenants 系 subcommand dispatch。
 * Usage:
 *   tenkacloud tenants list [--json|--csv]
 *   tenkacloud tenants get <tenantId> [--json|--csv]
 *   tenkacloud tenants create --name <n> --tier <t> --admin-email <e>
 *   tenkacloud tenants delete <tenantId>
 */

export interface TenantsDeps {
  readonly auth: FetchAuthConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
}

export async function runTenants(args: readonly string[], deps: TenantsDeps): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const sub = args[0];
  const rest = args.slice(1);
  const parsed = parseFlags(rest);
  const format = parseFormat(rest);
  const baseUrl = resolveApiBase("control", deps.env ?? process.env);
  const api = new TenantsApi(baseUrl, deps.auth);

  switch (sub) {
    case "list": {
      const tenants = await api.list();
      out(
        formatOutput(tenants, format, {
          columns: ["tenantId", "tenantName", "tier", "status", "email"],
        }),
      );
      return 0;
    }
    case "get": {
      const tenantId = requirePositional(parsed, 0, "<tenantId>");
      const tenant = await api.get(tenantId);
      out(formatOutput(tenant, format));
      return 0;
    }
    case "create": {
      const tenant = await api.create({
        tenantName: requireFlag(parsed, "name"),
        tier: requireFlag(parsed, "tier"),
        email: requireFlag(parsed, "admin-email"),
      });
      out(formatOutput(tenant, format));
      return 0;
    }
    case "delete": {
      const tenantId = requirePositional(parsed, 0, "<tenantId>");
      await api.delete(tenantId);
      out(`Deleted: ${tenantId}`);
      return 0;
    }
    default:
      out(
        "Usage: tenkacloud tenants <list|get|create|delete> [args]\n" +
          "  list                                       一覧表示\n" +
          "  get <tenantId>                             詳細取得\n" +
          "  create --name <n> --tier <t> --admin-email <e>\n" +
          "  delete <tenantId>                          削除",
      );
      return sub === undefined ? 0 : 1;
  }
}
