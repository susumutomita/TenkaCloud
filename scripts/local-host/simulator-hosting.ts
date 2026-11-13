import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { normalizeSimulatorEndpointUrl } from "@tenkacloud/portal-contracts";
import { connectCloudHosting } from "./cloud-hosting";
import { bootstrapSimulatorRole, SIMULATOR_DEPLOY_ROLE } from "./simulator-bootstrap";
import { connectSimulatorCapabilities } from "./simulator-console";

export type SimulatorSettings = {
  readonly endpoint: string;
  readonly region: string;
  readonly bootstrap?: boolean;
} & ({ readonly tokenFile: string } | { readonly readToken: () => string });

const TOKEN_FORMAT_ERROR =
  "Simulator input must contain a valid local operator token (32-256 URL-safe characters, optionally followed by one newline in a file). Do not paste its contents into logs.";

/** Opt-in only: neither AWS environment variables nor legacy cloud flags enable simulation. */
export function simulatorSettings(values: {
  "simulator-endpoint"?: string;
  "simulator-token-file"?: string;
  "simulator-token"?: string;
  "simulator-region"?: string;
  "simulator-bootstrap"?: boolean;
}): SimulatorSettings | undefined {
  const endpoint = values["simulator-endpoint"];
  const tokenFile = values["simulator-token-file"];
  const token = values["simulator-token"];
  const region = values["simulator-region"];
  if (
    endpoint === undefined &&
    tokenFile === undefined &&
    token === undefined &&
    region === undefined &&
    !values["simulator-bootstrap"]
  )
    return undefined;
  if (tokenFile !== undefined && token !== undefined)
    throw new Error("Choose --simulator-token-file or --simulator-token, not both.");
  if (!endpoint || (!tokenFile?.trim() && token === undefined) || !region)
    throw new Error(
      "Simulator mode requires --simulator-endpoint, one of --simulator-token-file or --simulator-token, and --simulator-region together.",
    );
  if (token !== undefined && !/^[A-Za-z0-9_-]{32,256}$/u.test(token))
    throw new Error(TOKEN_FORMAT_ERROR);
  const localEndpoint = normalizeSimulatorEndpointUrl(endpoint);
  if (!/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d{1,2}$/u.test(region))
    throw new Error("Simulator region must be a commercial AWS region identifier.");
  return {
    endpoint: localEndpoint,
    // A function keeps direct credentials out of JSON/logged option objects.
    ...(token !== undefined ? { readToken: () => token } : { tokenFile: resolve(tokenFile ?? "") }),
    region,
    ...(values["simulator-bootstrap"] ? { bootstrap: true } : {}),
  };
}

class SimulatorTokenFileError extends Error {}

function tokenFileReadError(error: unknown): Error {
  if (error instanceof SimulatorTokenFileError) return error;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR")
    return new Error(
      "Simulator token file was not found. --simulator-token-file is relative to the host working directory, not the Simulator checkout. Start the Simulator, then pass the absolute path to its existing simulator-token file. No token was created or changed.",
    );
  if (code === "EACCES" || code === "EPERM")
    return new Error(
      "Simulator token file is not readable by this user. Use the private file owned by the user running both the Simulator and host; do not make it public or run the host with sudo.",
    );
  return new Error(
    "Simulator token file must be a readable, owner-only regular file owned by this user containing a valid local operator token; symlinks are not accepted.",
  );
}

/** Bound the read and reject symlinks, devices, shared files and another user's credentials. */
export function readSimulatorToken(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new SimulatorTokenFileError("Simulator token file must be a regular file.");
    if (stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new SimulatorTokenFileError(
        "Simulator token file must be owner-only (for example mode 0600), with no hard links. Check the existing Simulator file's metadata; do not copy or recreate its token.",
      );
    if (stat.uid !== process.getuid?.())
      throw new SimulatorTokenFileError(
        "Simulator token file must be owned by this user. Run the Simulator and host as the same user, without sudo.",
      );
    if (stat.size > 257) throw new SimulatorTokenFileError(TOKEN_FORMAT_ERROR);
    const buffer = Buffer.alloc(258);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, size).toString("utf8").replace(/\n$/u, "");
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token))
      throw new SimulatorTokenFileError(TOKEN_FORMAT_ERROR);
    return token;
  } catch (error) {
    throw tokenFileReadError(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Bun may route even literal loopback Node HTTP requests through ambient proxies. */
export function assertSimulatorProxyDisabled(environment = process.env): void {
  if (
    Object.entries(environment).some(
      ([key, value]) => /^(http|https|all)_proxy$/iu.test(key) && Boolean(value),
    )
  )
    throw new Error(
      "Simulator host requires HTTP_PROXY, HTTPS_PROXY and ALL_PROXY (including lowercase variants) to be unset in its process. No request was sent.",
    );
}

/** Fail before catalog downloads, builds or host state; the connection rechecks before use. */
export function preflightSimulatorHosting(settings?: SimulatorSettings): void {
  if (!settings) return;
  assertSimulatorProxyDisabled();
  if ("tokenFile" in settings) readSimulatorToken(settings.tokenFile);
}

function simulatorProxyGuard<Input extends object, Output>(
  next: (args: { input: Input }) => Promise<Output>,
) {
  return async (args: { input: Input }): Promise<Output> => {
    assertSimulatorProxyDisabled();
    return next(args);
  };
}

function guardedSimulatorClient<
  T extends {
    middlewareStack: {
      add: (
        middleware: typeof simulatorProxyGuard,
        options: {
          step: "initialize";
          name: string;
          priority: "high";
        },
      ) => void;
    };
  },
>(client: T): T {
  client.middlewareStack.add(simulatorProxyGuard, {
    step: "initialize",
    name: "simulatorProxyGuard",
    priority: "high",
  });
  return client;
}

/** Explicit endpoint and local credentials on every SDK client: no default-chain AWS fallback. */
export async function connectSimulatorHosting(
  root: string,
  directory: string,
  settings?: SimulatorSettings,
) {
  if (!settings) return undefined;
  assertSimulatorProxyDisabled();
  if ("readToken" in settings)
    console.warn(
      "WARNING: --simulator-token exposes the operator token in process arguments and may leave it in shell history. Prefer automatic startup or --simulator-token-file. The token is not printed or saved by the host.",
    );
  const secretAccessKey =
    "tokenFile" in settings ? readSimulatorToken(settings.tokenFile) : settings.readToken();
  const { endpoint, region } = settings;
  const capabilities = await connectSimulatorCapabilities(
    endpoint,
    secretAccessKey,
    assertSimulatorProxyDisabled,
  );
  const connection = await connectCloudHosting(root, directory, region, {
    simulatorEndpoint: endpoint,
    simulatorConsole: capabilities.console,
    simulatorServices: capabilities.nativeSdkServices,
    sts: guardedSimulatorClient(
      new STSClient({
        endpoint,
        region,
        credentials: { accessKeyId: "TCSIMOPERATOR", secretAccessKey },
        maxAttempts: 1,
      }),
    ),
    cloudFormation: (credentials, stackRegion) =>
      guardedSimulatorClient(
        new CloudFormationClient({ endpoint, region: stackRegion, credentials, maxAttempts: 1 }),
      ),
    ssm: (config) => guardedSimulatorClient(new SSMClient({ ...config, endpoint })),
    federationFetch: async () => {
      throw new Error(
        "AWS console federation is unavailable in simulator mode. Use temporary CLI credentials with the simulator endpoint.",
      );
    },
  });
  if (settings.bootstrap) {
    await bootstrapSimulatorRole(
      guardedSimulatorClient(
        new CloudFormationClient({
          endpoint,
          region,
          credentials: { accessKeyId: "TCSIMOPERATOR", secretAccessKey },
          maxAttempts: 1,
        }),
      ),
      connection,
    );
    await connection.verify("000000000000", SIMULATOR_DEPLOY_ROLE);
  }
  return {
    ...connection,
    simulator: {
      endpoint,
      region,
      awsAccountId: "000000000000",
      bootstrapRoleName: SIMULATOR_DEPLOY_ROLE,
    },
  };
}
