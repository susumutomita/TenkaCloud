import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runHttpMode } from "./http-load";
import { renderHttpTable, renderStateTable, writeJsonReport } from "./report";
import { runStateMode } from "./state-sim";
import { machineInfo } from "./stats";

function parseIntList(raw: string): number[] {
  return raw.split(",").map((part) => {
    const value = Number(part.trim());
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`Invalid positive integer in list: "${part}"`);
    return value;
  });
}

function defaultOutPath(root: string, mode: string): string {
  return join(root, ".tenkacloud/bench", `${mode}-${String(Date.now())}.json`);
}

function defaultTeamCounts(quick: boolean): string {
  return quick ? "2,40" : "2,10,20,40";
}

function resolveMaxMinutes(raw: string | undefined, quick: boolean): number | null {
  if (raw !== undefined) return Number(raw);
  return quick ? 30 : null;
}

async function runState(
  root: string,
  values: Record<string, string | boolean | undefined>,
  quick: boolean,
): Promise<void> {
  const teamCounts = parseIntList(
    typeof values.teams === "string" ? values.teams : defaultTeamCounts(quick),
  );
  const sampleTeams = Number(values.sample ?? "5");
  const maxMinutes = resolveMaxMinutes(
    typeof values.minutes === "string" ? values.minutes : undefined,
    quick,
  );
  const results = await runStateMode({
    repositoryRoot: root,
    teamCounts,
    sampleTeams,
    maxMinutes,
    log: (message) => console.error(message),
  });
  console.log(renderStateTable(results));
  const outPath = typeof values.out === "string" ? values.out : defaultOutPath(root, "state");
  writeJsonReport(outPath, {
    machine: machineInfo(),
    generatedAt: new Date().toISOString(),
    mode: "state",
    config: { teamCounts, sampleTeams, maxMinutes },
    state: results,
  });
  console.error(`Full per-minute detail written to ${outPath}`);
}

async function runHttp(
  root: string,
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const teamsList = parseIntList(typeof values.teams === "string" ? values.teams : "40");
  const teams = teamsList[0] ?? 40;
  const tabCounts = parseIntList(
    typeof values.tabs === "string" ? values.tabs : "40,80,160,320,640,1280",
  );
  const durationSeconds = Number(values.duration ?? "60");
  const warmupSeconds = Number(values.warmup ?? "5");
  const adminPort = Number(values["admin-port"] ?? "6274");
  const participantPort = Number(values["participant-port"] ?? "6275");
  const gatewayPorts =
    typeof values["gateway-ports"] === "string" ? values["gateway-ports"] : "6300-6339";
  const result = await runHttpMode({
    repositoryRoot: root,
    teams,
    tabCounts,
    durationSeconds,
    warmupSeconds,
    adminPort,
    participantPort,
    gatewayPorts,
    log: (message) => console.error(message),
  });
  console.log(renderHttpTable(result));
  const outPath = typeof values.out === "string" ? values.out : defaultOutPath(root, "http");
  writeJsonReport(outPath, {
    machine: machineInfo(),
    generatedAt: new Date().toISOString(),
    mode: "http",
    config: {
      teams,
      tabCounts,
      durationSeconds,
      warmupSeconds,
      adminPort,
      participantPort,
      gatewayPorts,
    },
    http: result,
  });
  console.error(`Full per-step detail written to ${outPath}`);
}

async function main(): Promise<void> {
  // `bun run <script> -- --foo` sometimes hands the script a leading literal "--"; strip it so
  // `parseArgs({ strict: true })` does not reject it as a stray positional.
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      mode: { type: "string" },
      quick: { type: "boolean", default: false },
      teams: { type: "string" },
      sample: { type: "string" },
      minutes: { type: "string" },
      tabs: { type: "string" },
      duration: { type: "string" },
      warmup: { type: "string" },
      "admin-port": { type: "string" },
      "participant-port": { type: "string" },
      "gateway-ports": { type: "string" },
      out: { type: "string" },
    },
  });
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  if (values.mode === "state") {
    await runState(root, values, values.quick === true);
    return;
  }
  if (values.mode === "http") {
    await runHttp(root, values);
    return;
  }
  throw new Error("--mode must be 'state' or 'http'.");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
