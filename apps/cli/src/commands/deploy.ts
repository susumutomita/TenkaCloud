import { DeployApi } from "../api/deploy.ts";
import { resolveApiBase } from "../config/api-urls.ts";
import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { formatOutput, parseFormat } from "../output/format.ts";
import { parseFlags, requirePositional } from "./args.ts";

/**
 * Issue #1305: deploy 系 subcommand dispatch。
 * Usage:
 *   tenkacloud deploy <eventId> <teamId> <problemId>
 *   tenkacloud deploy bulk <eventId>
 *   tenkacloud deploy status <deploymentId>
 *   tenkacloud deploy logs <deploymentId>
 */

export interface DeployDeps {
  readonly auth: FetchAuthConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
}

export async function runDeploy(args: readonly string[], deps: DeployDeps): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const sub = args[0];
  const baseUrl = resolveApiBase("deploy", deps.env ?? process.env);
  const api = new DeployApi(baseUrl, deps.auth);

  // sub-keyword "bulk" / "status" / "logs" は予約。 それ以外は (eventId teamId problemId) deploy。
  if (sub === "bulk") {
    const rest = args.slice(1);
    const parsed = parseFlags(rest);
    const format = parseFormat(rest);
    const eventId = requirePositional(parsed, 0, "<eventId>");
    const deployments = await api.bulkDeploy(eventId);
    out(
      formatOutput(deployments, format, {
        columns: ["deploymentId", "teamId", "problemId", "status"],
      }),
    );
    return 0;
  }
  if (sub === "status") {
    const rest = args.slice(1);
    const parsed = parseFlags(rest);
    const format = parseFormat(rest);
    const deploymentId = requirePositional(parsed, 0, "<deploymentId>");
    const status = await api.status(deploymentId);
    out(formatOutput(status, format));
    return 0;
  }
  if (sub === "logs") {
    const rest = args.slice(1);
    const parsed = parseFlags(rest);
    const format = parseFormat(rest);
    const deploymentId = requirePositional(parsed, 0, "<deploymentId>");
    const logs = await api.logs(deploymentId);
    out(
      formatOutput(logs, format, {
        columns: ["timestamp", "level", "message"],
      }),
    );
    return 0;
  }
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    out(
      "Usage: tenkacloud deploy <subcommand|positional>\n" +
        "  <eventId> <teamId> <problemId>             1 deployment を発火\n" +
        "  bulk <eventId>                             event 全 team x 全 problem を一括 deploy\n" +
        "  status <deploymentId>                      deployment status を取得\n" +
        "  logs <deploymentId>                        deployment logs を取得",
    );
    return sub === undefined ? 0 : 0;
  }

  // default: deploy <eventId> <teamId> <problemId>
  const parsed = parseFlags(args);
  const format = parseFormat(args);
  const eventId = requirePositional(parsed, 0, "<eventId>");
  const teamId = requirePositional(parsed, 1, "<teamId>");
  const problemId = requirePositional(parsed, 2, "<problemId>");
  const deployment = await api.deploy(eventId, teamId, problemId);
  out(formatOutput(deployment, format));
  return 0;
}
