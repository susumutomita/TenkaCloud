import { IdpApi } from "../api/idp.ts";
import { resolveApiBase } from "../config/api-urls.ts";
import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { formatOutput, parseFormat } from "../output/format.ts";
import { parseFlags, requireFlag, requirePositional } from "./args.ts";

/**
 * Issue #1305: SAML IdP subcommand dispatch (Issues #1293/#1294)。
 * Usage:
 *   tenkacloud idp list
 *   tenkacloud idp create --name <n> --metadata-url <url>
 *   tenkacloud idp update <idpId> --metadata-url <url>
 *   tenkacloud idp delete <idpId>
 */

export interface IdpDeps {
  readonly auth: FetchAuthConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
}

export async function runIdp(args: readonly string[], deps: IdpDeps): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const sub = args[0];
  const rest = args.slice(1);
  const parsed = parseFlags(rest);
  const format = parseFormat(rest);
  const baseUrl = resolveApiBase("tenant", deps.env ?? process.env);
  const api = new IdpApi(baseUrl, deps.auth);

  switch (sub) {
    case "list": {
      const idps = await api.list();
      out(
        formatOutput(idps, format, {
          columns: ["idpId", "name", "metadataUrl", "status", "updatedAt"],
        }),
      );
      return 0;
    }
    case "create": {
      const idp = await api.create({
        name: requireFlag(parsed, "name"),
        metadataUrl: requireFlag(parsed, "metadata-url"),
      });
      out(formatOutput(idp, format));
      return 0;
    }
    case "update": {
      const idpId = requirePositional(parsed, 0, "<idpId>");
      const idp = await api.update(idpId, {
        metadataUrl: requireFlag(parsed, "metadata-url"),
      });
      out(formatOutput(idp, format));
      return 0;
    }
    case "delete": {
      const idpId = requirePositional(parsed, 0, "<idpId>");
      await api.delete(idpId);
      out(`Deleted: ${idpId}`);
      return 0;
    }
    default:
      out(
        "Usage: tenkacloud idp <list|create|update|delete> [args]\n" +
          "  list                                       一覧表示\n" +
          "  create --name <n> --metadata-url <url>     新規 IdP 登録\n" +
          "  update <idpId> --metadata-url <url>        metadata URL を更新\n" +
          "  delete <idpId>                             削除",
      );
      return sub === undefined ? 0 : 1;
  }
}
