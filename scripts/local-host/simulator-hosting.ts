import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { normalizeSimulatorEndpointUrl } from "@tenkacloud/portal-contracts";
import { connectCloudHosting } from "./cloud-hosting";
import { bootstrapSimulatorRole, SIMULATOR_DEPLOY_ROLE } from "./simulator-bootstrap";

export interface SimulatorSettings {
  readonly endpoint: string;
  readonly tokenFile: string;
  readonly region: string;
  readonly bootstrap?: boolean;
}

/** Opt-in only: neither AWS environment variables nor legacy cloud flags enable simulation. */
export function simulatorSettings(values: {
  "simulator-endpoint"?: string;
  "simulator-token-file"?: string;
  "simulator-region"?: string;
  "simulator-bootstrap"?: boolean;
}): SimulatorSettings | undefined {
  const endpoint = values["simulator-endpoint"];
  const tokenFile = values["simulator-token-file"];
  const region = values["simulator-region"];
  if (
    endpoint === undefined &&
    tokenFile === undefined &&
    region === undefined &&
    !values["simulator-bootstrap"]
  )
    return undefined;
  if (!endpoint || !tokenFile?.trim() || !region)
    throw new Error(
      "Simulator mode requires --simulator-endpoint, --simulator-token-file and --simulator-region together.",
    );
  const localEndpoint = normalizeSimulatorEndpointUrl(endpoint);
  if (!/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d{1,2}$/u.test(region))
    throw new Error("Simulator region must be a commercial AWS region identifier.");
  return {
    endpoint: localEndpoint,
    tokenFile: resolve(tokenFile),
    region,
    ...(values["simulator-bootstrap"] ? { bootstrap: true } : {}),
  };
}

/** Bound the read and reject symlinks, devices, shared files and another user's credentials. */
export function readSimulatorToken(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 257
    )
      throw new Error("unsafe file");
    const buffer = Buffer.alloc(258);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, size).toString("utf8").replace(/\n$/u, "");
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new Error("invalid token");
    return token;
  } catch {
    throw new Error(
      "Simulator token file must be a readable, owner-only regular file owned by this user containing a valid local operator token; symlinks are not accepted.",
    );
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
  const secretAccessKey = readSimulatorToken(settings.tokenFile);
  const { endpoint, region } = settings;
  const connection = await connectCloudHosting(root, directory, region, {
    simulatorEndpoint: endpoint,
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
