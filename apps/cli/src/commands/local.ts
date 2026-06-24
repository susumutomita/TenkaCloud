/**
 * Issue #1975: `tenkacloud local <up|serve|open|status|evaluate|down>` — 無料・セルフペースの
 * ローカル実行モード。 AWS / Cognito / SBT / CloudFormation を使わず、 participant-portal を
 * ローカルの Local Participant API (= node:http、 problems/ カタログ駆動) に向けて起動する。
 *
 * fixed local context: tenantId / eventId / teamId / participantId = "local"。
 *
 * すべての副作用 (fs / spawn / kill / fetch / browser-open / 常駐) は deps で注入し 100% unit
 * test 可能にする。 `serve` だけは常駐する worker (= `up` が detached で起動する子プロセス)。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadLocalCatalog } from "../local/catalog.ts";
import { generateLocalRuntimeConfig } from "../local/runtime-config.ts";
import { startLocalApi } from "../local/server.ts";

const DEFAULT_PORT = 3199;

export interface LocalState {
  readonly pid: number;
  readonly port: number;
  readonly apiBaseUrl: string;
  readonly problemId?: string;
  readonly runtimeConfigPath: string;
}

export interface LocalDeps {
  readonly out?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly fs: {
    readonly existsSync: (path: string) => boolean;
    readonly readFileSync: (path: string, encoding: "utf8") => string;
    readonly writeFileSync: (path: string, data: string) => void;
    readonly mkdirSync: (path: string, opts: { recursive: true }) => void;
    readonly rmSync: (path: string, opts: { force: true }) => void;
    readonly statIsDirectory: (path: string) => boolean;
    readonly readdirSync: (path: string) => readonly string[];
  };
  readonly spawnDetached: (command: string, args: readonly string[]) => number;
  readonly kill?: (pid: number) => void;
  readonly fetchImpl?: typeof fetch;
  readonly openBrowser?: (url: string) => void;
  readonly startApi?: typeof startLocalApi;
  /** prod では never-resolve で常駐、 test では即 resolve。 */
  readonly block?: () => Promise<void>;
  readonly cliBin?: string;
}

interface Resolved {
  readonly out: (line: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly dataDir: string;
  readonly statePath: string;
  readonly problemsDir: string;
  readonly runtimeConfigPath: string;
}

function resolveCtx(deps: LocalDeps): Resolved {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line: string) => console.log(line));
  const dataDir = env.TENKACLOUD_LOCAL_DIR ?? join(homedir(), ".tenkacloud", "local");
  const problemsDir = env.TENKACLOUD_PROBLEMS_DIR ?? join(process.cwd(), "problems");
  const runtimeConfigPath =
    env.TENKACLOUD_PORTAL_RUNTIME_CONFIG ??
    join(process.cwd(), "apps", "participant-portal", "public", "runtime-config.json");
  return {
    out,
    env,
    dataDir,
    statePath: join(dataDir, "state.json"),
    problemsDir,
    runtimeConfigPath,
  };
}

function parsePort(args: readonly string[], env: NodeJS.ProcessEnv): number {
  const idx = args.indexOf("--port");
  if (idx >= 0 && typeof args[idx + 1] === "string") {
    const n = Number(args[idx + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  const fromEnv = Number(env.TENKACLOUD_LOCAL_PORT ?? "");
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  return DEFAULT_PORT;
}

function firstPositional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") {
      i++;
      continue;
    }
    if (!a.startsWith("--")) return a;
  }
  return undefined;
}

function readState(ctx: Resolved, deps: LocalDeps): LocalState | undefined {
  if (!deps.fs.existsSync(ctx.statePath)) return undefined;
  try {
    return JSON.parse(deps.fs.readFileSync(ctx.statePath, "utf8")) as LocalState;
  } catch {
    return undefined;
  }
}

function catalogFs(deps: LocalDeps) {
  return {
    existsSync: deps.fs.existsSync,
    readdirSync: deps.fs.readdirSync,
    readFileSync: deps.fs.readFileSync,
    statIsDirectory: deps.fs.statIsDirectory,
  };
}

async function cmdUp(args: readonly string[], ctx: Resolved, deps: LocalDeps): Promise<number> {
  const port = parsePort(args, ctx.env);
  const problemId = firstPositional(args);
  // #1975: 非 flag kind は local では解けないので filter する。 隠した件数/id は ctx.out で明示。
  const catalog = loadLocalCatalog(ctx.problemsDir, catalogFs(deps), ctx.out);
  if (catalog.length === 0) {
    ctx.out(`No problems found under ${ctx.problemsDir} (set TENKACLOUD_PROBLEMS_DIR).`);
    return 1;
  }
  if (problemId && !catalog.some((p) => p.problemId === problemId)) {
    ctx.out(`Unknown problem: ${problemId}`);
    return 1;
  }
  deps.fs.mkdirSync(ctx.dataDir, { recursive: true });
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  const cliBin =
    deps.cliBin ??
    ctx.env.TENKACLOUD_CLI_BIN ??
    join(process.cwd(), "apps", "cli", "bin", "tenkacloud.ts");
  const serveArgs = ["local", "serve", "--port", String(port)];
  const pid = deps.spawnDetached(cliBin, serveArgs);
  deps.fs.writeFileSync(ctx.runtimeConfigPath, generateLocalRuntimeConfig({ apiBaseUrl }));
  const state: LocalState = {
    pid,
    port,
    apiBaseUrl,
    runtimeConfigPath: ctx.runtimeConfigPath,
    ...(problemId ? { problemId } : {}),
  };
  deps.fs.writeFileSync(ctx.statePath, `${JSON.stringify(state, null, 2)}\n`);
  ctx.out(`Local API starting on ${apiBaseUrl} (pid ${pid}).`);
  ctx.out(`Wrote portal runtime-config: ${ctx.runtimeConfigPath}`);
  ctx.out("Start the portal:  cd apps/participant-portal && bun run dev");
  ctx.out("Then:              tenkacloud local open   (login with any key)");
  return 0;
}

async function cmdServe(args: readonly string[], ctx: Resolved, deps: LocalDeps): Promise<number> {
  const port = parsePort(args, ctx.env);
  // #1975: 非 flag kind は local では解けないので filter する。 隠した件数/id は ctx.out で明示。
  const catalog = loadLocalCatalog(ctx.problemsDir, catalogFs(deps), ctx.out);
  const start = deps.startApi ?? startLocalApi;
  const handle = await start(port, catalog, "Local Player");
  ctx.out(
    `Local Participant API listening on http://127.0.0.1:${handle.port} (${catalog.length} problems).`,
  );
  await (deps.block ?? (() => new Promise<void>(() => {})))();
  await handle.close();
  return 0;
}

function cmdOpen(args: readonly string[], ctx: Resolved, deps: LocalDeps): number {
  const flagUrl = firstPositional(args);
  const state = readState(ctx, deps);
  const url = flagUrl ?? ctx.env.TENKACLOUD_PORTAL_URL ?? "http://localhost:5175";
  if (!flagUrl && !state) {
    ctx.out("Local mode is not running. Run `tenkacloud local up` first.");
    return 1;
  }
  const open = deps.openBrowser;
  if (!open) {
    ctx.out(`Open ${url} in your browser.`);
    return 0;
  }
  open(url);
  ctx.out(`Opened ${url}`);
  return 0;
}

async function cmdStatus(ctx: Resolved, deps: LocalDeps): Promise<number> {
  const state = readState(ctx, deps);
  if (!state) {
    ctx.out("Local mode: not running.");
    return 1;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let healthy = false;
  try {
    const res = await fetchImpl(`${state.apiBaseUrl}/healthz`);
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  ctx.out(`Local mode: ${healthy ? "running" : "state present but API unreachable"}`);
  ctx.out(`  api:  ${state.apiBaseUrl} (pid ${state.pid})`);
  if (state.problemId) ctx.out(`  problem: ${state.problemId}`);
  return healthy ? 0 : 1;
}

async function cmdEvaluate(
  args: readonly string[],
  ctx: Resolved,
  deps: LocalDeps,
): Promise<number> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const problemId = positional[0];
  const flag = positional[1];
  if (!problemId || !flag) {
    ctx.out("Usage: tenkacloud local evaluate <problemId> <flag>");
    return 2;
  }
  const state = readState(ctx, deps);
  if (!state) {
    ctx.out("Local mode is not running. Run `tenkacloud local up` first.");
    return 1;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`${state.apiBaseUrl}/portal/me/submit-flag`, {
    method: "POST",
    headers: { authorization: "Bearer local", "content-type": "application/json" },
    body: JSON.stringify({ problemId, flag }),
  });
  const outcome = (await res.json()) as { kind?: string; totalScore?: number };
  if (outcome.kind === "ok") {
    ctx.out(`Correct! total score: ${outcome.totalScore}`);
    return 0;
  }
  if (outcome.kind === "already_scored") {
    ctx.out("Already solved.");
    return 0;
  }
  ctx.out(`Incorrect. total score: ${outcome.totalScore ?? 0}`);
  return 1;
}

function cmdDown(ctx: Resolved, deps: LocalDeps): number {
  const state = readState(ctx, deps);
  if (!state) {
    ctx.out("Local mode: nothing to stop.");
    return 0;
  }
  const kill = deps.kill ?? ((pid: number) => process.kill(pid));
  try {
    kill(state.pid);
  } catch {
    // プロセスが既に居ない場合も state は掃除する (= 冪等)。
  }
  deps.fs.rmSync(ctx.statePath, { force: true });
  ctx.out(`Stopped local mode (pid ${state.pid}).`);
  return 0;
}

const USAGE = [
  "tenkacloud local — self-paced local mode (no AWS/Cognito)",
  "",
  "  local up [problemId] [--port N]   Start the local API + write portal runtime-config",
  "  local serve [--port N]            Run the local API in the foreground (used by `up`)",
  "  local open [url]                  Open the participant portal in a browser",
  "  local status                      Show whether the local API is running",
  "  local evaluate <problemId> <flag> Submit a flag to the local API",
  "  local down                        Stop the local API",
].join("\n");

export async function runLocal(args: readonly string[], deps: LocalDeps): Promise<number> {
  const ctx = resolveCtx(deps);
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "up":
      return cmdUp(rest, ctx, deps);
    case "serve":
      return cmdServe(rest, ctx, deps);
    case "open":
      return cmdOpen(rest, ctx, deps);
    case "status":
      return cmdStatus(ctx, deps);
    case "evaluate":
      return cmdEvaluate(rest, ctx, deps);
    case "down":
      return cmdDown(ctx, deps);
    default:
      ctx.out(USAGE);
      return sub === undefined ? 0 : 1;
  }
}
