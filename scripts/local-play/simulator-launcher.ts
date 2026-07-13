import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { isLoopbackUrl } from "./loopback";
import { createSimulatorLaunchSecret, decodeSimulatorLaunchSecret } from "./simulator-auth";

const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const WORKLOAD_IMAGE_DIGEST =
  /^(?:[a-z0-9][a-z0-9._/-]*\/)?[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const WORKLOAD_PROXY_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
export const DEFAULT_SIMULATOR_IMAGE =
  "ghcr.io/susumutomita/tenkacloud-simulator@sha256:0b8de36893513ffcf93db60a60e35849b3e592c08099adae2f0730a9f7fd1c9c";
const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
const MAX_WORKLOAD_IMAGES = 64;

export type SimulatorLauncherKind = "external" | "process" | "container";

export interface SimulatorNativeCredentials {
  readonly awsAccessKeyId: string;
  /** Local-only signing material required by standard AWS SDK/CLI credential providers. */
  readonly awsSecretAccessKey: string;
  readonly azureCredential: string;
  readonly gcpCredential: string;
  readonly sakuraCredential: string;
}

export interface SimulatorLauncherRecord {
  readonly kind: SimulatorLauncherKind;
  readonly baseUrl: string;
  readonly launchSecret: string;
  readonly nativeCredentials: SimulatorNativeCredentials;
  readonly pid?: number;
  readonly containerName?: string;
}

function urlSafeCredential(): string {
  return `tcsim_${randomBytes(24).toString("base64url")}`;
}

function createNativeCredentials(): SimulatorNativeCredentials {
  return {
    awsAccessKeyId: `TCSIM${randomBytes(8).toString("hex").toUpperCase().slice(0, 11)}`,
    awsSecretAccessKey: urlSafeCredential(),
    azureCredential: urlSafeCredential(),
    gcpCredential: urlSafeCredential(),
    sakuraCredential: `${urlSafeCredential()}:${urlSafeCredential()}`,
  };
}

function nativeCredentialEnv(credentials: SimulatorNativeCredentials): Record<string, string> {
  return {
    TENKACLOUD_SIMULATOR_AWS_ACCESS_KEY_ID: credentials.awsAccessKeyId,
    TENKACLOUD_SIMULATOR_AZURE_CREDENTIAL: credentials.azureCredential,
    TENKACLOUD_SIMULATOR_GCP_CREDENTIAL: credentials.gcpCredential,
    TENKACLOUD_SIMULATOR_SAKURA_CREDENTIAL: credentials.sakuraCredential,
  };
}

function externalNativeCredentials(env: NodeJS.ProcessEnv): SimulatorNativeCredentials {
  const awsAccessKeyId = env.TENKACLOUD_SIMULATOR_AWS_ACCESS_KEY_ID?.trim();
  const awsSecretAccessKey =
    env.TENKACLOUD_SIMULATOR_AWS_SECRET_ACCESS_KEY?.trim() ?? urlSafeCredential();
  const azureCredential = env.TENKACLOUD_SIMULATOR_AZURE_CREDENTIAL?.trim();
  const gcpCredential = env.TENKACLOUD_SIMULATOR_GCP_CREDENTIAL?.trim();
  const sakuraCredential = env.TENKACLOUD_SIMULATOR_SAKURA_CREDENTIAL?.trim();
  if (!awsAccessKeyId || !/^TCSIM[A-Z0-9]{11,123}$/.test(awsAccessKeyId)) {
    throw new Error("TENKACLOUD_SIMULATOR_AWS_ACCESS_KEY_ID is required and invalid");
  }
  const providerCredential = /^tcsim_[A-Za-z0-9_-]{16,128}$/;
  if (!providerCredential.test(awsSecretAccessKey)) {
    throw new Error("TENKACLOUD_SIMULATOR_AWS_SECRET_ACCESS_KEY is invalid");
  }
  if (!azureCredential || !providerCredential.test(azureCredential)) {
    throw new Error("TENKACLOUD_SIMULATOR_AZURE_CREDENTIAL is required and invalid");
  }
  if (!gcpCredential || !providerCredential.test(gcpCredential)) {
    throw new Error("TENKACLOUD_SIMULATOR_GCP_CREDENTIAL is required and invalid");
  }
  const sakuraParts = sakuraCredential?.split(":") ?? [];
  if (sakuraParts.length !== 2 || sakuraParts.some((part) => !providerCredential.test(part))) {
    throw new Error("TENKACLOUD_SIMULATOR_SAKURA_CREDENTIAL is required and invalid");
  }
  return {
    awsAccessKeyId,
    awsSecretAccessKey,
    azureCredential,
    gcpCredential,
    sakuraCredential,
  };
}

export interface SimulatorLauncherOptions {
  readonly stateDir: string;
  readonly logPath: string;
  readonly workloadImages?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export type SimulatorSource =
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "process"; readonly command: string }
  | { readonly kind: "container"; readonly image: string };

/** Resolve one explicit override, or the reviewed immutable default image. */
export function resolveSimulatorSource(env: NodeJS.ProcessEnv): SimulatorSource {
  const externalUrl = env.TENKACLOUD_SIMULATOR_URL?.trim();
  const command = env.TENKACLOUD_SIMULATOR_COMMAND?.trim();
  const explicitImage = env.TENKACLOUD_SIMULATOR_IMAGE?.trim();
  const configured = [externalUrl, command, explicitImage].filter((value) => value).length;
  if (configured > 1) {
    throw new Error("Configure exactly one Simulator source (command, image, or URL)");
  }
  if (externalUrl) return { kind: "external", url: externalUrl };
  if (command) return { kind: "process", command };
  return { kind: "container", image: explicitImage ?? DEFAULT_SIMULATOR_IMAGE };
}

function normalizedWorkloadImages(images: readonly string[] | undefined): readonly string[] {
  const requested = images ?? [];
  if (
    requested.length > MAX_WORKLOAD_IMAGES - 1 ||
    requested.some((image) => !WORKLOAD_IMAGE_DIGEST.test(image))
  ) {
    throw new Error("Simulator workload images must be digest-pinned catalog references");
  }
  return [
    ...new Set([...(requested.length > 0 ? [WORKLOAD_PROXY_IMAGE] : []), ...requested]),
  ].sort();
}

function workloadEnvironment(
  images: readonly string[],
  controlContainer?: string,
): Readonly<Record<string, string>> {
  if (images.length === 0) return {};
  return {
    TENKACLOUD_SIMULATOR_WORKLOAD_ALLOWED_IMAGES: JSON.stringify(images),
    TENKACLOUD_SIMULATOR_WORKLOAD_MAX_MEMORY_BYTES: "536870912",
    TENKACLOUD_SIMULATOR_WORKLOAD_MAX_MILLI_CPU: "1000",
    TENKACLOUD_SIMULATOR_WORKLOAD_MAX_PIDS: "128",
    TENKACLOUD_SIMULATOR_WORKLOAD_PROXY_IMAGE: WORKLOAD_PROXY_IMAGE,
    ...(controlContainer
      ? { TENKACLOUD_SIMULATOR_WORKLOAD_CONTROL_CONTAINER: controlContainer }
      : {}),
  };
}

function simulatorBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !isLoopbackUrl(url.toString())) {
    throw new Error("TENKACLOUD_SIMULATOR_URL must be an http:// loopback URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("TENKACLOUD_SIMULATOR_URL must not contain credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function privateStateDir(path: string): string {
  if (!isAbsolute(path)) throw new Error("Simulator state directory must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink())
    throw new Error("Simulator state directory must not be a symlink");
  chmodSync(path, 0o700);
  return realpathSync(path);
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("failed to reserve a loopback port for Simulator");
  return port;
}

function commandArgs(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("TENKACLOUD_SIMULATOR_ARGS must be a JSON string array");
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.includes("\0"))
  ) {
    throw new Error("TENKACLOUD_SIMULATOR_ARGS must be a JSON string array");
  }
  return value;
}

function assertExecutable(command: string): void {
  if (!isAbsolute(command)) {
    throw new Error("TENKACLOUD_SIMULATOR_COMMAND must be an absolute executable path");
  }
  accessSync(command, constants.X_OK);
}

function startProcess(
  command: string,
  args: readonly string[],
  port: number,
  launchSecret: string,
  stateDir: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
  nativeCredentials: SimulatorNativeCredentials,
  workloadImages: readonly string[],
): SimulatorLauncherRecord {
  assertExecutable(command);
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(command, [...args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...env,
      TENKACLOUD_SIMULATOR_HOST: "127.0.0.1",
      TENKACLOUD_SIMULATOR_PORT: String(port),
      TENKACLOUD_SIMULATOR_LAUNCH_SECRET: launchSecret,
      TENKACLOUD_SIMULATOR_STATE_DIR: stateDir,
      ...nativeCredentialEnv(nativeCredentials),
      ...workloadEnvironment(workloadImages),
    },
  });
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error("Simulator executable did not start");
  return {
    kind: "process",
    baseUrl: `http://127.0.0.1:${port}`,
    launchSecret,
    nativeCredentials,
    pid: child.pid,
  };
}

function dockerCli(value: string | undefined): string {
  const cli = value?.trim() || "docker";
  if (/\s/.test(cli) || cli.includes("\0")) {
    throw new Error("TENKACLOUD_SIMULATOR_DOCKER_CLI must name one executable");
  }
  return cli;
}

function dockerSocket(value: string | undefined): string {
  const path = value?.trim() || DEFAULT_DOCKER_SOCKET;
  const segments = path.split("/");
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    path.includes(",") ||
    /[\r\n]/.test(path) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("TENKACLOUD_SIMULATOR_DOCKER_SOCKET must be a safe absolute UNIX path");
  }
  return path;
}

function dockerSocketGroup(cli: string, image: string, socket: string): string {
  const result = spawnSync(
    cli,
    [
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${socket},dst=/var/run/docker.sock,readonly`,
      "--entrypoint",
      "/usr/bin/stat",
      image,
      "-c",
      "%g",
      "/var/run/docker.sock",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const group = result.stdout.trim();
  if (result.status !== 0 || !/^\d{1,10}$/.test(group)) {
    throw new Error(
      `Simulator workload Docker socket inspection failed: ${result.stderr.trim() || "invalid socket group"}`,
    );
  }
  return group;
}

function startContainer(
  image: string,
  port: number,
  launchSecret: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  nativeCredentials: SimulatorNativeCredentials,
  workloadImages: readonly string[],
): SimulatorLauncherRecord {
  if (!IMAGE_DIGEST.test(image)) {
    throw new Error(
      "TENKACLOUD_SIMULATOR_IMAGE must be digest-pinned as name@sha256:<64 lowercase hex>",
    );
  }
  const name = `tenkacloud-simulator-${randomUUID()}`;
  const containerStateDir = "/var/lib/tenkacloud-simulator";
  const cli = dockerCli(env.TENKACLOUD_SIMULATOR_DOCKER_CLI);
  const workloadEnabled = workloadImages.length > 0;
  const socket = workloadEnabled ? dockerSocket(env.TENKACLOUD_SIMULATOR_DOCKER_SOCKET) : undefined;
  const socketGroup = socket === undefined ? undefined : dockerSocketGroup(cli, image, socket);
  const result = spawnSync(
    cli,
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16777216",
      "--publish",
      `127.0.0.1:${port}:${port}`,
      "--mount",
      `type=bind,src=${stateDir},dst=${containerStateDir}`,
      ...(socket === undefined
        ? []
        : [
            "--mount",
            `type=bind,src=${socket},dst=/var/run/docker.sock,readonly`,
            "--group-add",
            socketGroup ?? "",
          ]),
      "--env",
      "TENKACLOUD_SIMULATOR_CONTAINER_MODE=1",
      "--env",
      "TENKACLOUD_SIMULATOR_HOST=0.0.0.0",
      "--env",
      `TENKACLOUD_SIMULATOR_PORT=${port}`,
      "--env",
      `TENKACLOUD_SIMULATOR_PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
      "--env",
      `TENKACLOUD_SIMULATOR_LAUNCH_SECRET=${launchSecret}`,
      "--env",
      `TENKACLOUD_SIMULATOR_STATE_DIR=${containerStateDir}`,
      ...Object.entries(nativeCredentialEnv(nativeCredentials)).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
      ...Object.entries(
        workloadEnvironment(workloadImages, workloadEnabled ? name : undefined),
      ).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      image,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`Simulator container failed to start: ${result.stderr.trim()}`);
  }
  return {
    kind: "container",
    baseUrl: `http://127.0.0.1:${port}`,
    launchSecret,
    nativeCredentials,
    containerName: name,
  };
}

/**
 * Resolve exactly one real Simulator boundary. An explicit loopback URL adopts
 * an operator-managed process; otherwise a real executable or digest-pinned
 * image is launched. With no override, the reviewed immutable image is used.
 */
export async function launchSimulator(
  options: SimulatorLauncherOptions,
): Promise<SimulatorLauncherRecord> {
  const env = options.env ?? process.env;
  const workloadImages = normalizedWorkloadImages(options.workloadImages);
  const source = resolveSimulatorSource(env);
  const stateDir = privateStateDir(options.stateDir);
  if (source.kind === "external") {
    const launchSecret = env.TENKACLOUD_SIMULATOR_LAUNCH_SECRET?.trim();
    if (!launchSecret) {
      throw new Error(
        "TENKACLOUD_SIMULATOR_LAUNCH_SECRET is required with TENKACLOUD_SIMULATOR_URL",
      );
    }
    decodeSimulatorLaunchSecret(launchSecret);
    return {
      kind: "external",
      baseUrl: simulatorBaseUrl(source.url),
      launchSecret,
      nativeCredentials: externalNativeCredentials(env),
    };
  }
  const nativeCredentials = createNativeCredentials();
  const port = await freeLoopbackPort();
  const launchSecret = createSimulatorLaunchSecret();
  if (source.kind === "process") {
    return startProcess(
      source.command,
      commandArgs(env.TENKACLOUD_SIMULATOR_ARGS),
      port,
      launchSecret,
      stateDir,
      options.logPath,
      env,
      nativeCredentials,
      workloadImages,
    );
  }
  return startContainer(
    source.image,
    port,
    launchSecret,
    stateDir,
    env,
    nativeCredentials,
    workloadImages,
  );
}

export function stopSimulatorLauncher(
  launcher: SimulatorLauncherRecord,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (launcher.kind === "process" && launcher.pid !== undefined) {
    try {
      process.kill(launcher.pid, "SIGTERM");
    } catch {
      // Idempotent cleanup: a crashed Simulator process is already stopped.
    }
  }
  if (launcher.kind === "container" && launcher.containerName) {
    const result = spawnSync(
      dockerCli(env.TENKACLOUD_SIMULATOR_DOCKER_CLI),
      ["stop", launcher.containerName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0 && !result.stderr.includes("No such container")) {
      throw new Error(`Simulator container failed to stop: ${result.stderr.trim()}`);
    }
  }
}
