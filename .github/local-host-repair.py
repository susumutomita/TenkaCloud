"""Temporary branch repair script; removed before merge, never runs on main."""
from pathlib import Path
import json

changed = set()
def edit(name, old, new, count=1):
    path = Path(name)
    source = path.read_text()
    if new in source and old not in source:
        return
    assert source.count(old) == count, (name, old[:140], source.count(old))
    path.write_text(source.replace(old, new))
    changed.add(name)
def write(name, content):
    path = Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    changed.add(name)

# Bun's prepare() statements outlive close(false). Own and finalize every
# prepared statement before releasing the exclusive SQLite connection.
model = 'scripts/local-host/model.ts'
edit(model, 'export interface SqlStatement {', 'type SqlBinding = string | number | null;\n\nexport interface SqlStatement {\n  finalize?(): void;')
edit(model, '(string | number | null)[]', 'SqlBinding[]', 3)
edit(model, '/[\\u0000-\\u001f]/u.test(value)', '[...value].some(character => character < " ")')
store = 'scripts/local-host/store.ts'
edit(store, 'type SqlDatabase,', 'type SqlDatabase,\n  type SqlStatement,')
edit(store, 'export class HostStore {', '''export class HostStore {
  private readonly statements = new Map<string, SqlStatement>();
  private connectionClosed = false;

  private statement(sql: string): SqlStatement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get closed(): boolean { return this.connectionClosed; }
''')
p = Path(store); s = p.read_text()
# Preserve the one raw prepare inside statement(); route all callers through it.
start = s.index('  constructor(')
s = s[:start] + s[start:].replace('this.database.prepare(', 'this.statement(').replace('database.prepare(', 'this.statement(')
p.write_text(s);changed.add(store)
edit(store, 'this.database.close();', '''if (this.connectionClosed) return;
    for (const statement of this.statements.values()) statement.finalize?.();
    this.statements.clear();
    this.database.close();
    this.connectionClosed = true;''')
edit(store, '''    const rows = eventId === undefined
      ? this.statement("SELECT body FROM host_jobs ORDER BY rowid").all()
      : teamId === undefined
        ? this.statement("SELECT body FROM host_jobs WHERE event_id=? ORDER BY rowid").all(eventId)
        : this.statement("SELECT body FROM host_jobs WHERE event_id=? AND team_id=? ORDER BY rowid").all(eventId, teamId);''', '''    let rows: unknown[];
    if (eventId === undefined) {
      rows = this.statement("SELECT body FROM host_jobs ORDER BY rowid").all();
    } else if (teamId === undefined) {
      rows = this.statement("SELECT body FROM host_jobs WHERE event_id=? ORDER BY rowid").all(eventId);
    } else {
      rows = this.statement("SELECT body FROM host_jobs WHERE event_id=? AND team_id=? ORDER BY rowid").all(eventId, teamId);
    }''')

# An empty Vite glob array is invalid in Vite 7. A reserved empty path is a
# literal valid glob; assertHostingModule still rejects any future content there.
p = Path('scripts/local-host/browser-metadata.ts');s=p.read_text()
old = '"[]"'
assert s.count(old)==1
s=s.replace(old, ''''"../../../../problems/challenges/sqli-demo/__local_host_empty__/**/*"' ''')
s=s.replace('Empty import.meta.glob arrays are supported by Vite and expand to an empty map.', 'The reserved empty glob is valid in Vite 7; the module guard rejects any accidental match.')
p.write_text(s);changed.add(str(p))
edit('scripts/local-host/tests/run.ts', 'assert.ok(transformed.includes("import.meta.glob([])"));', 'assert.ok(transformed.includes("sqli-demo/__local_host_empty__/**/*"));')

# Make the dependency injection port require the callable fetch contract, not
# Bun's unrelated static preconnect property.
edit('scripts/local-play/verify-client.ts', 'readonly fetchImpl?: typeof fetch;', 'readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;')
edit('scripts/local-play/api-scoring.ts', '''  if (!runtime && !simulatedRuntime) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
  }
  if (simulatedRuntime) return revealSimulatorHint(simulatedRuntime, state, iso, hintId);''', '''  if (simulatedRuntime) return revealSimulatorHint(simulatedRuntime, state, iso, hintId);
  if (!runtime) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
  }''')
edit('scripts/local-play/api-views.ts', '''  if (scoring.kind === "multi-flag") {
    return scoring.flags.every((flag) => runtime.solved.has(flag.id));
  }
''', '')
edit('scripts/local-play/state-store.ts', 'function snapshotProgress(runtime: ProblemRuntime)', 'type ProgressRuntime = Pick<ProblemRuntime, "solved" | "revealedHints" | "wrongCounts" | "score">;\n\nfunction snapshotProgress(runtime: ProgressRuntime)')
edit('scripts/local-play/state-store.ts', 'function restoreProgress(runtime: ProblemRuntime,', 'function restoreProgress(runtime: ProgressRuntime,')

edit('infrastructure/lib/problem-deploy/runtime-clients/ssrf-guard.ts', 'if (dotted) return dotted[1];', 'if (dotted?.[1] !== undefined) return dotted[1];')
edit('infrastructure/lib/problem-deploy/runtime-clients/ssrf-guard.ts', 'if (hex) {', 'if (hex?.[1] !== undefined && hex[2] !== undefined) {')
edit('packages/saml-utils/src/metadata.ts', '!entityIdMatch || entityIdMatch[1].trim().length === 0', 'entityIdMatch?.[1] === undefined || entityIdMatch[1].trim().length === 0')
edit('scripts/local-play/compose-policy.ts', '  if (!fs.realpathSync || !fs.existsSync(lexical)) {', '  const resolveRealPath = fs.realpathSync;\n  if (!resolveRealPath || !fs.existsSync(lexical)) {')
edit('scripts/local-play/compose-policy.ts', 'const real = fs.realpathSync(lexical);', 'const real = resolveRealPath(lexical);')
edit('scripts/local-play/compose-policy.ts', 'const realRoot = fs.realpathSync(root);', 'const realRoot = resolveRealPath(root);')
edit('scripts/local-play/manifest.ts', 'if (matches.length === 0) {', 'if (matches[0] === undefined) {')

# Retain strict indexing: validate actual capture groups rather than asserting
# they must exist or weakening noUncheckedIndexedAccess.
p=Path('scripts/local-play/process-identity.ts');s=p.read_text()
s=s.replace('match.groups.state', 'state').replace('match.groups.startTime', 'startTime')
needle='  if (!match?.groups'
assert needle in s
idx=s.index(needle)
s=s[:idx]+'''  const state = match?.groups?.state;
  const startTime = match?.groups?.startTime;
'''+s[idx:]
s=s.replace('if (!match?.groups', 'if (!state || !startTime')
p.write_text(s);changed.add(str(p))

p=Path('scripts/local-play/simulator-client.ts');s=p.read_text()
# A copied Uint8Array has an ArrayBuffer backing, satisfying the DOM BodyInit
# contract even when the original view might be SharedArrayBuffer-backed.
old='new Response(bodyForbidden ? null : body,'
if old in s: s=s.replace(old,'new Response(bodyForbidden ? null : new Uint8Array(body),')
else:
    old='new Response(bodyAllowed ? body : null,'
    if old in s:s=s.replace(old,'new Response(bodyAllowed ? new Uint8Array(body) : null,')
    else:
        # Print the exact expression for the next diagnostic; do not guess.
        print('BODY_EXPRESSION',str(p),'\n'.join(s.splitlines()[208:232]))
p.write_text(s);changed.add(str(p))
p=Path('scripts/local-play/simulator-data-plane-proxy.ts');s=p.read_text()
old='...(body ? { body } : {})'
if old in s:s=s.replace(old,'...(body ? { body: new Uint8Array(body) } : {})')
else: print('PROXY_BODY_EXPRESSION','\n'.join(s.splitlines()[287:316]))
p.write_text(s);changed.add(str(p))

edit('scripts/local-play/simulator-launch-state.ts', '''    launchIntentPath: String(value.launchIntentPath),
  };''', '''    launchIntentPath: String(value.launchIntentPath),
  } as const;''')
edit('scripts/local-play/simulator-launch-state.ts', 'if (sakuraParts.length !== 2 || sakuraParts.some', 'if (!sakuraCredential || sakuraParts.length !== 2 || sakuraParts.some')
edit('scripts/local-play/simulator-launcher.ts', 'if (!identity || observeProcessIdentity(child.pid) !== identity)', 'if (!registration || !identity || observeProcessIdentity(child.pid) !== identity)')

p='scripts/local-play/simulator-runtime-lifecycle.ts'
edit(p, 'export abstract class SimulatorRuntimeLifecycle', '''type SimulatorClient = ReturnType<typeof createSimulatorClient>;

interface PreparedWorldStart {
  readonly launcher: SimulatorLauncherRecord;
  readonly pending: SimulatorPendingWorldRecord;
  readonly client: SimulatorClient;
}

export abstract class SimulatorRuntimeLifecycle''')
p='scripts/local-play/simulator-runtime.ts'
edit(p, '  type SimulatedCloudProblem,', '  type createSimulatorClient,\n  type SimulatedCloudProblem,')
edit(p, 'import { nativeTargets, type SimulatorNativeRoute }', 'import { nativeTargets, type NativeTarget, type SimulatorNativeRoute }')
edit(p, 'target: SimulatorNativeTarget,', 'target: NativeTarget,')
edit(p, 'export class SimulatorLocalRuntime', 'type SimulatorClient = ReturnType<typeof createSimulatorClient>;\n\nexport class SimulatorLocalRuntime')
p='scripts/local-play/simulator-scoring.ts'
edit(p, 'return keys.length === 1 ? outputs[keys[0]] : undefined;', 'const key = keys[0];\n  return key === undefined ? undefined : outputs[key];')
# The simulator contract rejects multi-flag. Removing this unreachable branch
# does not expose a supported flag; the ordinary flag guard remains unchanged.
edit(p, '''  if (scoring.kind === "multi-flag") {
    for (const flag of scoring.flags) hidden.add(flag.flagOutputKey);
  }
''', '')
edit(p, '  return runAttackDetectionKind({ ...genericInput, scoring: contract.scoring });', '''  if (contract.scoring.kind === "attack-detection") {
    return runAttackDetectionKind({ ...genericInput, scoring: contract.scoring });
  }
  throw new Error("Unsupported simulator scoring kind");''')
p=Path('scripts/local-play/simulator.ts');s=p.read_text()
# The one-artifact validation remains, now narrows the actual element too.
old='artifacts.length !== 1'
if old in s:s=s.replace(old,'artifacts.length !== 1 || artifacts[0] === undefined')
else: print('ARTIFACT_EXPRESSION','\n'.join(s.splitlines()[395:435]))
p.write_text(s);changed.add(str(p))

write('scripts/local-host/environment.d.ts', '''/** Named optional environment inputs used by the shared hosting runtime. */
declare namespace NodeJS {
  interface ProcessEnv {
    CONTROL_DATA_BACKEND?: string;
    CONTROL_DATA_TURSO_URL?: string;
    CONTROL_DATA_TURSO_AUTH_TOKEN?: string;
    CONTROL_DATA_ENV?: string;
    TENKACLOUD_COMPOSE_CLI?: string;
    CODESPACE_NAME?: string;
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?: string;
  }
}
''')
p=Path('tsconfig.host.json');cfg=json.loads(p.read_text())
for candidate in Path('scripts').rglob('*.d.ts'):
    if 'node_modules' not in candidate.parts and 'declare module "js-yaml"' in candidate.read_text():
        if str(candidate) not in cfg['include']:cfg['include'].append(str(candidate))
p.write_text(json.dumps(cfg,indent=2)+'\n');changed.add(str(p))

# Make failures observable instead of hiding the initial exception during test
# cleanup. No assertion or supported production path is skipped.
p=Path('scripts/local-host/tests/docker-smoke.ts');s=p.read_text()
s=s.replace('    failed = true;\n    throw error;', '    failed = true;\n    console.error("Production Docker smoke failed:", error);\n    throw error;')
s=s.replace('for (const job of store.jobs()) {', 'for (const job of store.closed ? [] : store.jobs()) {')
s=s.replace('if (!failed) throw new AggregateError(cleanupErrors, "Production smoke cleanup failed.");', 'if (!failed) process.exitCode = 1;')
s=s.replace('password: "not-known"', 'password: secret()')
s='import { secret } from "../auth";\n'+s
p.write_text(s);changed.add(str(p))
p=Path('scripts/local-host/tests/run.ts');s=p.read_text()
s=s.replace('password: "unknown"', 'password: secret()')
s=s.replace('() => { }', '() => { /* Expected boundary failures are asserted by the caller. */ }')
s=s.replace('      await entry.run();', '      console.log(`RUN ${entry.name}`);\n      await entry.run();')
s=s.replace('"192.168.1.2"','TEST_PRIVATE_ADDRESS')
s='// eslint-disable-next-line sonarjs/no-hardcoded-ip -- RFC1918 parser test vector; no connection is made.\nconst TEST_PRIVATE_ADDRESS = "192.168.1.2";\n'+s
p.write_text(s);changed.add(str(p))
edit('scripts/local-host/tests/exercise-fixture.ts', 'const flag = `TC{${createHash("sha256").update(`flag:${job.jobId}`).digest("hex").slice(0, 20)}}`;', 'const flagHash = createHash("sha256").update(`flag:${job.jobId}`).digest("hex").slice(0, 20);\n    const flag = `TC{${flagHash}}`;')

# Register actual new executable/build entries with the existing dead-code
# analyzer. Do not disable findings or enlarge a suppression baseline.
p=Path('knip.json');cfg=json.loads(p.read_text());workspaces=cfg['workspaces']
for entry in ['scripts/local-host/main.ts','scripts/local-host/build-main.ts','scripts/local-host/tests/run.ts','scripts/local-host/tests/docker-smoke.ts']:
    if entry not in workspaces['.']['entry']:workspaces['.']['entry'].append(entry)
for app in ['application-admin-console','participant-portal']:
    workspace=workspaces['apps/'+app]
    for entry in ['src/main.tsx','src/local-host/main.tsx','vite.host.config.ts']:
        if entry not in workspace['entry']:workspace['entry'].append(entry)
p.write_text(json.dumps(cfg,indent=2)+'\n');changed.add(str(p))
print('REPAIR_PATHS',json.dumps(sorted(changed)))
