import { ScoreboardApi } from "../api/scoreboard.ts";
import { resolveApiBase } from "../config/api-urls.ts";
import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { formatOutput, parseFormat } from "../output/format.ts";
import { parseFlags, requirePositional } from "./args.ts";

/**
 * Issue #1305: scoreboard / score-events subcommand dispatch。
 * Usage:
 *   tenkacloud scoreboard <eventId>
 *   tenkacloud score-events <eventId> [--team <t>] [--from <iso>] [--to <iso>]
 */

export interface ScoreboardDeps {
  readonly auth: FetchAuthConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
}

export async function runScoreboard(
  args: readonly string[],
  deps: ScoreboardDeps,
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const parsed = parseFlags(args);
  const format = parseFormat(args);
  const baseUrl = resolveApiBase("event", deps.env ?? process.env);
  const api = new ScoreboardApi(baseUrl, deps.auth);
  const eventId = requirePositional(parsed, 0, "<eventId>");
  const rows = await api.scoreboard(eventId);
  out(
    formatOutput(rows, format, {
      columns: ["rank", "teamId", "teamName", "score", "updatedAt"],
    }),
  );
  return 0;
}

export async function runScoreEvents(
  args: readonly string[],
  deps: ScoreboardDeps,
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const parsed = parseFlags(args);
  const format = parseFormat(args);
  const baseUrl = resolveApiBase("event", deps.env ?? process.env);
  const api = new ScoreboardApi(baseUrl, deps.auth);
  const eventId = requirePositional(parsed, 0, "<eventId>");
  const events = await api.scoreEvents(eventId, {
    team: parsed.flags.team,
    from: parsed.flags.from,
    to: parsed.flags.to,
  });
  out(
    formatOutput(events, format, {
      columns: ["eventTime", "teamId", "problemId", "delta", "reason"],
    }),
  );
  return 0;
}
