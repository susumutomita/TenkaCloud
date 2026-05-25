import { writeFileSync } from "node:fs";
import { AuditApi } from "../api/audit.ts";
import { resolveApiBase } from "../config/api-urls.ts";
import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { formatCsv, formatOutput, parseFormat } from "../output/format.ts";
import { parseFlags, requireFlag } from "./args.ts";

/**
 * Issue #1305: audit log subcommand dispatch (Issue #1292)。
 * Usage:
 *   tenkacloud audit query [--from <iso>] [--to <iso>] [--principal <p>] [--action <a>]
 *   tenkacloud audit export --from <iso> --to <iso> --out audit.csv
 */

export interface AuditDeps {
  readonly auth: FetchAuthConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  /** test 用 file write 差し替え hook */
  readonly writeFile?: (path: string, content: string) => void;
}

export async function runAudit(args: readonly string[], deps: AuditDeps): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const sub = args[0];
  const rest = args.slice(1);
  const parsed = parseFlags(rest);
  const baseUrl = resolveApiBase("tenant", deps.env ?? process.env);
  const api = new AuditApi(baseUrl, deps.auth);

  switch (sub) {
    case "query": {
      const format = parseFormat(rest);
      const entries = await api.query({
        from: parsed.flags.from,
        to: parsed.flags.to,
        principal: parsed.flags.principal,
        action: parsed.flags.action,
      });
      out(
        formatOutput(entries, format, {
          columns: ["timestamp", "principal", "action", "resource", "outcome", "source"],
        }),
      );
      return 0;
    }
    case "export": {
      const from = requireFlag(parsed, "from");
      const to = requireFlag(parsed, "to");
      const outPath = requireFlag(parsed, "out");
      const entries = await api.query({
        from,
        to,
        principal: parsed.flags.principal,
        action: parsed.flags.action,
      });
      const csv = formatCsv(entries, {
        columns: ["timestamp", "principal", "action", "resource", "outcome", "source"],
      });
      const write = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
      write(outPath, csv);
      out(`Exported ${entries.length} entries → ${outPath}`);
      return 0;
    }
    default:
      out(
        "Usage: tenkacloud audit <query|export> [args]\n" +
          "  query [--from <iso>] [--to <iso>] [--principal <p>] [--action <a>]\n" +
          "  export --from <iso> --to <iso> --out <path>",
      );
      return sub === undefined ? 0 : 1;
  }
}
