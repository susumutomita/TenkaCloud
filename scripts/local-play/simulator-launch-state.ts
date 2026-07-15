import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isLoopbackUrl } from "./loopback";
import { readPrivateJson, unlinkIfExists, writePrivateJson } from "./session-state";
import { decodeSimulatorLaunchSecret } from "./simulator-auth";

export const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
export const WORKLOAD_IMAGE_DIGEST =
  /^(?:[a-z0-9][a-z0-9._/-]*\/)?[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
export const WORKLOAD_PROXY_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
export const DEFAULT_SIMULATOR_IMAGE =
  "ghcr.io/susumutomita/tenkacloud-simulator@sha256:049c6c165f9947b386b2c5864983aebefba26e996ec62859dae0e9814c52d505";
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
export const LAUNCHER_STOP_TIMEOUT_MS = 5_000;
export const LAUNCH_REGISTRATION_TIMEOUT_MS = 3_000;
export const LAUNCH_INTENT_VERSION = "1";
export const MAX_WORKLOAD_IMAGES = 64;
export const SAFE_PROCESS_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "DOCKER_HOST",
  "XDG_RUNTIME_DIR",
] as const;

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
  /** Hash of the PID and OS-observed start time, used to reject PID reuse before signaling. */
  readonly processIdentity?: string;
  /** Supervised command identity, retained so cleanup survives supervisor loss. */
  readonly childPid?: number;
  readonly childProcessIdentity?: string;
  readonly containerName?: string;
  /** Private lease watched by the process supervisor until this launcher stops. */
  readonly ownershipLeasePath?: string;
  /** Private supervisor registration used to recover after a parent crash. */
  readonly registrationPath?: string;
  readonly launchIntentPath?: string;
}

interface SimulatorLaunchIntentBase {
  readonly version: typeof LAUNCH_INTENT_VERSION;
  readonly intentId: string;
  readonly createdAtMs: number;
  readonly baseUrl: string;
  readonly launchSecret: string;
  readonly nativeCredentials: SimulatorNativeCredentials;
  readonly stateDir: string;
  readonly workloadImages: readonly string[];
  readonly launchIntentPath: string;
}

export type SimulatorOwnedLaunchIntent =
  | (SimulatorLaunchIntentBase & {
      readonly kind: "process";
      readonly command: string;
      readonly args: readonly string[];
      readonly logPath: string;
      readonly registrationPath: string;
      readonly ownershipLeasePath: string;
    })
  | (SimulatorLaunchIntentBase & {
      readonly kind: "container";
      readonly image: string;
      readonly containerName: string;
    });

export type SimulatorLaunchPreparation =
  | { readonly kind: "external"; readonly launcher: SimulatorLauncherRecord }
  | { readonly kind: "owned"; readonly intent: SimulatorOwnedLaunchIntent };

export interface SimulatorProcessRegistration {
  readonly pid: number;
  readonly startTime: string;
  readonly childPid?: number;
  readonly childStartTime?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNativeCredentials(value: unknown): SimulatorNativeCredentials {
  if (!isRecord(value)) throw new Error("Simulator launch intent credentials are invalid");
  const keys = [
    "awsAccessKeyId",
    "awsSecretAccessKey",
    "azureCredential",
    "gcpCredential",
    "sakuraCredential",
  ] as const;
  if (keys.some((key) => typeof value[key] !== "string" || value[key].length === 0)) {
    throw new Error("Simulator launch intent credentials are invalid");
  }
  return value as unknown as SimulatorNativeCredentials;
}

export function simulatorLaunchIntentPath(sessionPath: string): string {
  return join(dirname(sessionPath), "simulator-launch-intent.json");
}

export function expectedRegistrationPath(sessionPath: string, intentId: string): string {
  return join(dirname(sessionPath), `simulator-launch-${intentId}.json`);
}

export function expectedOwnershipLeasePath(sessionPath: string, intentId: string): string {
  return join(dirname(sessionPath), `simulator-launch-${intentId}.lease`);
}

function parseOwnedLaunchIntent(value: unknown, sessionPath: string): SimulatorOwnedLaunchIntent {
  if (!isRecord(value)) throw new Error("Simulator launch intent is invalid");
  const intentId = value.intentId;
  const baseUrl = value.baseUrl;
  const stateDir = value.stateDir;
  const workloadImages = value.workloadImages;
  if (
    value.version !== LAUNCH_INTENT_VERSION ||
    typeof intentId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    Number(value.createdAtMs) < 0 ||
    typeof baseUrl !== "string" ||
    !isLoopbackUrl(baseUrl) ||
    !baseUrl.startsWith("http://") ||
    typeof value.launchSecret !== "string" ||
    !isAbsolute(String(stateDir)) ||
    !Array.isArray(workloadImages) ||
    workloadImages.some((image) => typeof image !== "string" || !WORKLOAD_IMAGE_DIGEST.test(image))
  ) {
    throw new Error("Simulator launch intent is invalid");
  }
  decodeSimulatorLaunchSecret(value.launchSecret);
  const common = {
    version: LAUNCH_INTENT_VERSION,
    intentId,
    createdAtMs: Number(value.createdAtMs),
    baseUrl,
    launchSecret: value.launchSecret,
    nativeCredentials: parseNativeCredentials(value.nativeCredentials),
    stateDir: String(stateDir),
    workloadImages: workloadImages as readonly string[],
    launchIntentPath: String(value.launchIntentPath),
  };
  if (value.launchIntentPath !== simulatorLaunchIntentPath(sessionPath)) {
    throw new Error("Simulator launch intent path is invalid");
  }
  if (value.kind === "process") {
    if (
      typeof value.command !== "string" ||
      !isAbsolute(value.command) ||
      !Array.isArray(value.args) ||
      value.args.some((item) => typeof item !== "string" || item.includes("\0")) ||
      typeof value.logPath !== "string" ||
      !isAbsolute(value.logPath) ||
      value.registrationPath !== expectedRegistrationPath(sessionPath, intentId) ||
      value.ownershipLeasePath !== expectedOwnershipLeasePath(sessionPath, intentId)
    ) {
      throw new Error("Simulator process launch intent is invalid");
    }
    return {
      ...common,
      kind: "process",
      command: value.command,
      args: value.args as readonly string[],
      logPath: value.logPath,
      registrationPath: value.registrationPath,
      ownershipLeasePath: value.ownershipLeasePath,
    };
  }
  if (
    value.kind !== "container" ||
    typeof value.image !== "string" ||
    !IMAGE_DIGEST.test(value.image) ||
    typeof value.containerName !== "string" ||
    value.containerName !== `tenkacloud-simulator-${intentId}`
  ) {
    throw new Error("Simulator container launch intent is invalid");
  }
  return {
    ...common,
    kind: "container",
    image: value.image,
    containerName: value.containerName,
  };
}

export function readSimulatorLaunchIntent(
  sessionPath: string,
): SimulatorOwnedLaunchIntent | undefined {
  const path = simulatorLaunchIntentPath(sessionPath);
  if (!existsSync(path)) return undefined;
  return parseOwnedLaunchIntent(readPrivateJson<unknown>(path, 64 * 1024), sessionPath);
}

export function writeSimulatorLaunchIntent(
  sessionPath: string,
  intent: SimulatorOwnedLaunchIntent,
): void {
  writePrivateJson(
    simulatorLaunchIntentPath(sessionPath),
    parseOwnedLaunchIntent(intent, sessionPath),
  );
}

export function clearSimulatorLaunchIntent(sessionPath: string): void {
  unlinkIfExists(simulatorLaunchIntentPath(sessionPath));
}

export function releaseProcessLaunchFiles(
  launcher: Pick<
    SimulatorLauncherRecord,
    "launchIntentPath" | "ownershipLeasePath" | "registrationPath"
  >,
): void {
  if (launcher.ownershipLeasePath) unlinkIfExists(launcher.ownershipLeasePath);
  if (launcher.registrationPath) unlinkIfExists(launcher.registrationPath);
  if (launcher.launchIntentPath) unlinkIfExists(launcher.launchIntentPath);
}

function urlSafeCredential(): string {
  return `tcsim_${randomBytes(24).toString("base64url")}`;
}

export function createNativeCredentials(): SimulatorNativeCredentials {
  return {
    awsAccessKeyId: `TCSIM${randomBytes(8).toString("hex").toUpperCase().slice(0, 11)}`,
    awsSecretAccessKey: urlSafeCredential(),
    azureCredential: urlSafeCredential(),
    gcpCredential: urlSafeCredential(),
    sakuraCredential: `${urlSafeCredential()}:${urlSafeCredential()}`,
  };
}

export function nativeCredentialEnv(
  credentials: SimulatorNativeCredentials,
): Record<string, string> {
  return {
    TENKACLOUD_SIMULATOR_AWS_ACCESS_KEY_ID: credentials.awsAccessKeyId,
    TENKACLOUD_SIMULATOR_AZURE_CREDENTIAL: credentials.azureCredential,
    TENKACLOUD_SIMULATOR_GCP_CREDENTIAL: credentials.gcpCredential,
    TENKACLOUD_SIMULATOR_SAKURA_CREDENTIAL: credentials.sakuraCredential,
  };
}

export function externalNativeCredentials(env: NodeJS.ProcessEnv): SimulatorNativeCredentials {
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
