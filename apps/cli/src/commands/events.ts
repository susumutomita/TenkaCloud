import { EventsApi } from "../api/events.ts";
import { resolveApiBase } from "../config/api-urls.ts";
import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { formatOutput, parseFormat } from "../output/format.ts";
import { parseFlags, requireFlag, requirePositional } from "./args.ts";

/**
 * Issue #1305: events 系 subcommand dispatch。
 */

export interface EventsDeps {
  readonly auth: FetchAuthConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
}

export async function runEvents(args: readonly string[], deps: EventsDeps): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const sub = args[0];
  const rest = args.slice(1);
  const parsed = parseFlags(rest);
  const format = parseFormat(rest);
  const baseUrl = resolveApiBase("tenant", deps.env ?? process.env);
  const api = new EventsApi(baseUrl, deps.auth);

  switch (sub) {
    case "list": {
      const events = await api.list(parsed.flags.status);
      out(
        formatOutput(events, format, {
          columns: ["eventId", "name", "status", "startAt", "endAt", "problemset"],
        }),
      );
      return 0;
    }
    case "get": {
      const eventId = requirePositional(parsed, 0, "<eventId>");
      const event = await api.get(eventId);
      out(formatOutput(event, format));
      return 0;
    }
    case "create": {
      const event = await api.create({
        name: requireFlag(parsed, "name"),
        start: requireFlag(parsed, "start"),
        end: requireFlag(parsed, "end"),
        problemset: requireFlag(parsed, "problemset"),
      });
      out(formatOutput(event, format));
      return 0;
    }
    case "end": {
      const eventId = requirePositional(parsed, 0, "<eventId>");
      const event = await api.end(eventId);
      out(formatOutput(event, format));
      return 0;
    }
    case "archive": {
      const eventId = requirePositional(parsed, 0, "<eventId>");
      const event = await api.archive(eventId);
      out(formatOutput(event, format));
      return 0;
    }
    case "report": {
      const eventId = requirePositional(parsed, 0, "<eventId>");
      const report = await api.report(eventId);
      out(report.markdown);
      return 0;
    }
    default:
      out(
        "Usage: tenkacloud events <list|get|create|end|archive|report> [args]\n" +
          "  list [--status <s>]                        一覧表示\n" +
          "  get <eventId>                              詳細取得\n" +
          "  create --name --start --end --problemset   新規作成\n" +
          "  end <eventId>                              競技終了\n" +
          "  archive <eventId>                          archive\n" +
          "  report <eventId>                           markdown 形式 summary",
      );
      return sub === undefined ? 0 : 1;
  }
}
