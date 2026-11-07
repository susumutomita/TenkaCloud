import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { copyLocalCatalog } from "../../problem-pack/local-catalog";
import { directWebTransport } from "../direct-web-transport";
import { assertSimulatorProxyDisabled, readSimulatorToken } from "../simulator-hosting";
import {
  prepareFixtureCatalog,
  readFixtureCatalogSelection,
  verifyFixtureSources,
} from "./simulator-fixture-catalog";
import { verifyServedFixtureAssets } from "./simulator-fixture-http";
import {
  type FixtureProcess,
  fixtureCommandOutput,
  registerFixtureInterruptCleanup,
  SimulatorFixtureError,
  spawnFixtureProcess,
  waitForFixtureReady,
  withinFixtureDeadline,
} from "./simulator-fixture-process";

const REGION = "ap-northeast-1";
const sessionSchema = z.object({
  protocol: z.literal(2),
  pid: z.number().int().positive(),
  port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
type LocalSession = z.infer<typeof sessionSchema>;

/** No inherited AWS configuration, proxy, shell startup hooks or user credential chains. */
export function fixtureEnvironment(home: string, bin: string): NodeJS.ProcessEnv {
  return {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: join(home, "tmp"),
    LANG: "C",
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
  };
}

function executableFile(value: string, label: string): string {
  try {
    const path = realpathSync(resolve(value));
    if (!value.trim() || !statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    throw new SimulatorFixtureError(`${label} must name an existing executable file.`);
  }
}

function reservePorts(count: number): number[] {
  const listeners: ReturnType<typeof Bun.serve>[] = [];
  try {
    for (let index = 0; index < count; index++)
      listeners.push(
        Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) }),
      );
    return listeners.map((server) => {
      if (!server.port) throw new SimulatorFixtureError("Could not allocate a loopback port.");
      return server.port;
    });
  } finally {
    for (const server of listeners) void server.stop(true);
  }
}

function readLocalSession(directory: string): LocalSession {
  const fd = openSync(
    join(directory, "local-session.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new SimulatorFixtureError("Refusing an unsafe fixture control session.");
    return sessionSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

async function localRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    !target.port ||
    target.username ||
    target.password
  )
    throw new SimulatorFixtureError("Fixture requests require a direct numeric loopback URL.");
  // The existing transport binds a numeric TCP connection, does not use proxies or follow redirects,
  // and caps both response bytes and request time. Readiness gets an even shorter deadline.
  return directWebTransport(target, { ...init, signal: AbortSignal.timeout(2000) });
}

function control(session: LocalSession, directory: string, action: string): Promise<Response> {
  return localRequest(`http://127.0.0.1:${String(session.port)}${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-tenkacloud-data-directory": encodeURIComponent(directory),
    },
  });
}

/** Escape both make's variable expansion and its recipe shell; no caller-supplied shell program. */
function makeArgument(value: string): string {
  return `'${value.replaceAll("$", "$$").replaceAll("'", "'\\''")}'`;
}

export function copyFixtureRuntime(
  repositoryRoot: string,
  root: string,
  bin: string,
  bun: string,
): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  for (const name of ["scripts", "packages"])
    copyLocalCatalog(join(repositoryRoot, name), join(root, name));
  for (const name of ["Makefile", "package.json", "tsconfig.scripts.json", "tsconfig.host.json"])
    cpSync(join(repositoryRoot, name), join(root, name));
  // Dependencies are only read. Catalog acquisition and all mutable runtime data are private.
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(bun, join(bin, "bun"));
}

interface FixtureHost {
  readonly adminOrigin: string;
  readonly participantOrigin: string;
  readonly organizerKey: string;
  stop(): Promise<void>;
}

interface HostOptions {
  readonly root: string;
  readonly data: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly endpoint: string;
  readonly tokenFile: string;
  readonly make: string;
  readonly onSpawn: (child: FixtureProcess) => void;
  readonly assertActive: () => void;
  readonly verifyCatalog: () => void;
  readonly verifyAssets: (origins: {
    adminOrigin: string;
    participantOrigin: string;
  }) => Promise<void>;
}

async function launchFixtureHost(options: HostOptions): Promise<FixtureHost> {
  options.assertActive();
  options.verifyCatalog();
  const [adminPort, participantPort] = reservePorts(2);
  const adminOrigin = `http://127.0.0.1:${String(adminPort)}`;
  const participantOrigin = `http://127.0.0.1:${String(participantPort)}`;
  const args = [
    "--no-build",
    "--data",
    options.data,
    "--admin-port",
    String(adminPort),
    "--participant-port",
    String(participantPort),
    "--simulator-endpoint",
    options.endpoint,
    "--simulator-token-file",
    options.tokenFile,
    "--simulator-region",
    REGION,
    "--simulator-bootstrap",
  ];
  const child = spawnFixtureProcess(
    [options.make, "local", `LOCAL_ARGS=${args.map(makeArgument).join(" ")}`],
    { cwd: options.root, environment: options.environment },
  );
  options.onSpawn(child);
  let session: LocalSession | undefined;
  try {
    await waitForFixtureReady(
      child,
      async () => {
        const status = await localRequest(`${adminOrigin}/api/host/bootstrap-status`);
        if (!status.ok) return false;
        const admin = await localRequest(`${adminOrigin}/`);
        const participant = await localRequest(`${participantOrigin}/`);
        if (!admin.ok || !participant.ok) return false;
        if (
          !(await admin.text()).includes("<html") ||
          !(await participant.text()).includes("<html")
        )
          return false;
        session = readLocalSession(options.data);
        return true;
      },
      30_000,
      "make local",
    );
    options.assertActive();
    options.verifyCatalog();
    await options.verifyAssets({ adminOrigin, participantOrigin });
    options.assertActive();
    if (!session) throw new SimulatorFixtureError("Local host control session is unavailable.");
    const currentSession = session;
    const reset = await control(currentSession, options.data, "/reset-organizer-key");
    const rotation = z
      .object({
        sessionId: z.literal(currentSession.sessionId),
        directory: z.literal(options.data),
        key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      })
      .safeParse(await reset.json());
    if (!reset.ok || !rotation.success)
      throw new SimulatorFixtureError("Could not confirm the private organizer-key rotation.");
    options.assertActive();
    let stopping: Promise<void> | undefined;
    return {
      adminOrigin,
      participantOrigin,
      organizerKey: rotation.data.key,
      stop() {
        stopping ??= (async () => {
          try {
            const response = await control(currentSession, options.data, "/down");
            const result = z
              .object({
                sessionId: z.literal(currentSession.sessionId),
                directory: z.literal(options.data),
                code: z.literal(0),
              })
              .safeParse(await response.json());
            if (!response.ok || !result.success)
              throw new SimulatorFixtureError("Local host graceful shutdown was not confirmed.");
            if (
              (await withinFixtureDeadline(
                child.exited,
                10_000,
                "make local shutdown timed out.",
              )) !== 0
            )
              throw new SimulatorFixtureError("make local did not exit successfully.");
          } finally {
            await child.stop();
          }
        })();
        return stopping;
      },
    };
  } catch (error) {
    await child.stop();
    throw error;
  }
}

/** Explicit opt-in only: never download tools, rebuild interfaces or touch the shared catalog. */
export async function startSimulatorFixture(options: { binary: string; awsCli: string }) {
  if (Bun.version !== "1.4.4")
    throw new SimulatorFixtureError("Acceptance requires Bun 1.4.4 exactly.");
  try {
    assertSimulatorProxyDisabled();
  } catch {
    throw new SimulatorFixtureError(
      "Unset HTTP_PROXY, HTTPS_PROXY and ALL_PROXY, including lowercase variants, before acceptance.",
    );
  }
  const binary = executableFile(options.binary, "Simulator binary");
  const simulatorBinarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const suppliedAwsCli = executableFile(options.awsCli, "AWS CLI");
  const bun = executableFile(process.execPath, "Bun");
  const make = Bun.which("make", { PATH: "/usr/bin:/bin" });
  if (!make) throw new SimulatorFixtureError("Install make before simulator acceptance.");
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  // A fixed system temp parent keeps make/PATH syntax out of generated paths, regardless of TMPDIR.
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp atomically creates a unique owner-only (0700) directory; nothing is written to a predictable shared path.
  const tempDirectory = realpathSync(mkdtempSync("/tmp/tenka-simulator-acceptance-"));
  const root = join(tempDirectory, "runtime");
  const home = join(tempDirectory, "home");
  const bin = join(tempDirectory, "bin");
  let simulator: FixtureProcess | undefined;
  let activeHost: FixtureHost | undefined;
  const children = new Set<FixtureProcess>();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const assertActive = () => {
    if (stopped) throw new SimulatorFixtureError("The simulator fixture is already stopped.");
  };
  const trackChild = (child: FixtureProcess) => {
    children.add(child);
  };
  const stop = () => {
    stopping ??= (async () => {
      stopped = true;
      let failure: unknown;
      try {
        await activeHost?.stop();
      } catch (error) {
        failure = error;
      }
      // Include version checks and make processes still awaiting readiness, not just active hosts.
      const results = await Promise.allSettled([...children].map((child) => child.stop()));
      for (const result of results) if (result.status === "rejected") failure ??= result.reason;
      // Never remove state whose owning process could not be confirmed stopped.
      if (failure) throw failure;
      rmSync(tempDirectory, { recursive: true, force: true });
    })().finally(() => unregisterInterrupt());
    return stopping;
  };
  const unregisterInterrupt = registerFixtureInterruptCleanup(stop);
  try {
    mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
    const baseEnvironment = fixtureEnvironment(home, bin);
    const version = await fixtureCommandOutput([suppliedAwsCli, "--version"], {
      cwd: tempDirectory,
      environment: baseEnvironment,
      onSpawn: trackChild,
    });
    assertActive();
    if (!/^aws-cli\/1\.46\.3(?:\s|$)/u.test(version))
      throw new SimulatorFixtureError("Acceptance requires official AWS CLI 1.46.3 exactly.");
    copyFixtureRuntime(repositoryRoot, root, bin, bun);
    const awsCli = join(bin, "aws");
    symlinkSync(suppliedAwsCli, awsCli);
    const catalog = prepareFixtureCatalog(repositoryRoot, root, tempDirectory);
    const [port] = reservePorts(1);
    const endpoint = `http://127.0.0.1:${String(port)}`;
    const tokenFile = join(tempDirectory, "simulator-token");
    simulator = spawnFixtureProcess(
      [
        binary,
        "--listen",
        `127.0.0.1:${String(port)}`,
        "--state",
        join(tempDirectory, "simulator.sqlite"),
        "--token-file",
        tokenFile,
      ],
      { cwd: tempDirectory, environment: baseEnvironment },
    );
    trackChild(simulator);
    let token = "";
    await waitForFixtureReady(
      simulator,
      async () => {
        token = readSimulatorToken(tokenFile);
        return (
          await localRequest(`${endpoint}/_simulator/health`, {
            headers: { "X-Simulator-Token": token },
          })
        ).ok;
      },
      15_000,
      "Simulator",
    );
    assertActive();
    const operatorCredentials = { accessKeyId: "TCSIMOPERATOR", secretAccessKey: token };
    const environment: NodeJS.ProcessEnv = {
      ...baseEnvironment,
      AWS_ACCESS_KEY_ID: operatorCredentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: token,
      AWS_ENDPOINT_URL: endpoint,
      AWS_REGION: REGION,
      AWS_DEFAULT_REGION: REGION,
      CATALOG_SOURCES: catalog.configFile,
    };
    const data = join(tempDirectory, "host-data");
    return {
      root,
      tempDirectory,
      endpoint,
      region: REGION,
      operatorCredentials,
      awsCli,
      bun,
      environment,
      catalogDigest: catalog.catalogDigest,
      templateHash: catalog.templateHash,
      // Report only the exact version we accepted, never arbitrary subprocess output.
      awsCliVersion: "1.46.3",
      simulatorBinarySha256,
      hostBuildFingerprint: catalog.provenance.sourceFingerprint,
      servedAssetCount: catalog.provenance.artifacts.length,
      async startHost() {
        assertActive();
        if (activeHost) throw new SimulatorFixtureError("Stop the current host before restarting.");
        const host = await launchFixtureHost({
          root,
          data,
          environment,
          endpoint,
          tokenFile,
          make,
          onSpawn: trackChild,
          assertActive,
          verifyCatalog: () => {
            if (readFixtureCatalogSelection(repositoryRoot) !== catalog.identity)
              throw new SimulatorFixtureError(
                "The shared catalog selection changed during acceptance.",
              );
            verifyFixtureSources(root, tempDirectory, catalog.identity);
          },
          verifyAssets: (origins) => verifyServedFixtureAssets(root, catalog.provenance, origins),
        });
        activeHost = host;
        return {
          ...host,
          async stop() {
            try {
              await host.stop();
            } finally {
              if (activeHost === host) activeHost = undefined;
            }
          },
        };
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
