import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "./session-state";
import { SIMULATOR_PROTOCOL_VERSION, type SimulatorDeploymentResponse } from "./simulator";
import { simulatorConsoleUrl } from "./simulator-auth";
import type {
  SimulatorLauncherKind,
  SimulatorLauncherRecord,
  SimulatorNativeCredentials,
} from "./simulator-launcher";

export interface SimulatorSessionDeploymentRecord {
  readonly problemId: string;
  readonly worldId: string;
  readonly deploymentId: string;
  readonly launchToken: string;
  readonly status: SimulatorDeploymentResponse["status"];
  readonly outputs: Readonly<Record<string, string>>;
  readonly consoleUrl: string;
  readonly nativeCredentials: SimulatorNativeCredentials;
  readonly clockObservedAtMs: number;
}

export interface SimulatorPendingWorldRecord {
  readonly problemId: string;
  readonly deploymentId: string;
  readonly launchToken: string;
}

export interface SimulatorPendingSnapshotRestoreRecord {
  readonly problemId: string;
  readonly deploymentId: string;
  readonly sourceWorldId: string;
  readonly snapshotHash: string;
  readonly idempotencyKey: string;
  /** Present as soon as the clone response or restore lookup is observed. */
  readonly restoredWorldId?: string;
}

export interface SimulatorCompletedSnapshotRestoreRecord {
  readonly problemId: string;
  readonly deploymentId: string;
  readonly sourceWorldId: string;
  readonly restoredWorldId: string;
  readonly snapshotHash: string;
  readonly idempotencyKey: string;
}

/** The complete in-memory record. It is split before either file is written. */
export interface SimulatorSessionRecord {
  readonly protocolVersion: typeof SIMULATOR_PROTOCOL_VERSION;
  readonly launcher: SimulatorLauncherRecord;
  readonly deployments: readonly SimulatorSessionDeploymentRecord[];
  /** Durable create intent used to recover a committed world after a lost response. */
  readonly pendingWorldCreates?: readonly SimulatorPendingWorldRecord[];
  /** Durable restore intent and dual-world ownership until the source is deleted. */
  readonly pendingSnapshotRestores?: readonly SimulatorPendingSnapshotRestoreRecord[];
  /** Latest bounded success receipt used to make a lost operator response idempotent. */
  readonly completedSnapshotRestores?: readonly SimulatorCompletedSnapshotRestoreRecord[];
  /** The owned launcher was stopped after a failure and must be replaced before reuse. */
  readonly launcherNeedsReplacement?: boolean;
}

interface SimulatorPublicLauncherRecord {
  readonly kind: SimulatorLauncherKind;
  readonly baseUrl: string;
  readonly pid?: number;
  readonly processIdentity?: string;
  readonly containerName?: string;
}

interface SimulatorPublicDeploymentRecord {
  readonly problemId: string;
  readonly worldId: string;
  readonly deploymentId: string;
  readonly status: SimulatorDeploymentResponse["status"];
  readonly consoleBaseUrl: string;
  readonly clockObservedAtMs: number;
}

interface SimulatorPublicSessionRecord {
  readonly protocolVersion: typeof SIMULATOR_PROTOCOL_VERSION;
  readonly recordId: string;
  readonly launcher: SimulatorPublicLauncherRecord;
  readonly deployments: readonly SimulatorPublicDeploymentRecord[];
  readonly pendingWorldCreates?: readonly {
    readonly problemId: string;
    readonly deploymentId: string;
  }[];
  readonly pendingSnapshotRestores?: readonly {
    readonly problemId: string;
    readonly deploymentId: string;
    readonly sourceWorldId: string;
    readonly snapshotHash: string;
    readonly restoredWorldId?: string;
  }[];
  readonly launcherNeedsReplacement?: boolean;
}

interface SimulatorSessionSecretsRecord {
  readonly protocolVersion: typeof SIMULATOR_PROTOCOL_VERSION;
  readonly recordId: string;
  /** Self-contained recovery source; may include scoring answers and credentials. */
  readonly session: SimulatorSessionRecord;
}

const nativeCredentialsSchema = z.object({
  awsAccessKeyId: z.string().min(1),
  awsSecretAccessKey: z.string().min(1),
  azureCredential: z.string().min(1),
  gcpCredential: z.string().min(1),
  sakuraCredential: z.string().min(1),
});

const sessionSchema = z.object({
  protocolVersion: z.literal(SIMULATOR_PROTOCOL_VERSION),
  launcher: z.object({
    kind: z.enum(["external", "process", "container"]),
    baseUrl: z.string().url(),
    launchSecret: z.string().min(1),
    nativeCredentials: nativeCredentialsSchema,
    pid: z.number().int().positive().optional(),
    processIdentity: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    childPid: z.number().int().positive().optional(),
    childProcessIdentity: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    containerName: z.string().min(1).optional(),
    ownershipLeasePath: z.string().min(1).optional(),
    registrationPath: z.string().min(1).optional(),
    launchIntentPath: z.string().min(1).optional(),
  }),
  deployments: z.array(
    z.object({
      problemId: z.string().min(1),
      worldId: z.string().min(1),
      deploymentId: z.string().min(1),
      launchToken: z.string().min(1),
      status: z.enum(["accepted", "deploying", "running", "failed", "deleting", "deleted"]),
      outputs: z.record(z.string(), z.string()),
      consoleUrl: z.string().url(),
      nativeCredentials: nativeCredentialsSchema,
      clockObservedAtMs: z.number().int().safe(),
    }),
  ),
  pendingWorldCreates: z
    .array(
      z.object({
        problemId: z.string().min(1),
        deploymentId: z.string().min(1),
        launchToken: z.string().min(1),
      }),
    )
    .optional(),
  pendingSnapshotRestores: z
    .array(
      z.object({
        problemId: z.string().min(1),
        deploymentId: z.string().min(1),
        sourceWorldId: z.string().min(1),
        snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        idempotencyKey: z.string().min(1),
        restoredWorldId: z.string().min(1).optional(),
      }),
    )
    .optional(),
  completedSnapshotRestores: z
    .array(
      z.object({
        problemId: z.string().min(1),
        deploymentId: z.string().min(1),
        sourceWorldId: z.string().min(1),
        restoredWorldId: z.string().min(1),
        snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        idempotencyKey: z.string().min(1),
      }),
    )
    .optional(),
  launcherNeedsReplacement: z.boolean().optional(),
});

const publicSessionSchema = z.object({
  protocolVersion: z.literal(SIMULATOR_PROTOCOL_VERSION),
  recordId: z.string().uuid(),
  launcher: z.object({
    kind: z.enum(["external", "process", "container"]),
    baseUrl: z.string().url(),
    pid: z.number().int().positive().optional(),
    processIdentity: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    containerName: z.string().min(1).optional(),
  }),
  deployments: z.array(
    z.object({
      problemId: z.string().min(1),
      worldId: z.string().min(1),
      deploymentId: z.string().min(1),
      status: z.enum(["accepted", "deploying", "running", "failed", "deleting", "deleted"]),
      consoleBaseUrl: z.string().url(),
      clockObservedAtMs: z.number().int().safe(),
    }),
  ),
  pendingWorldCreates: z
    .array(
      z.object({
        problemId: z.string().min(1),
        deploymentId: z.string().min(1),
      }),
    )
    .optional(),
  pendingSnapshotRestores: z
    .array(
      z.object({
        problemId: z.string().min(1),
        deploymentId: z.string().min(1),
        sourceWorldId: z.string().min(1),
        snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        restoredWorldId: z.string().min(1).optional(),
      }),
    )
    .optional(),
  launcherNeedsReplacement: z.boolean().optional(),
});

const secretEnvelopeSchema = z.object({
  protocolVersion: z.literal(SIMULATOR_PROTOCOL_VERSION),
  recordId: z.string().uuid(),
  session: sessionSchema,
});

/** Transitional format used before the protected record became self-contained. */
const legacySplitSecretsSchema = z.object({
  protocolVersion: z.literal(SIMULATOR_PROTOCOL_VERSION),
  recordId: z.string().uuid(),
  launcher: z.object({
    launchSecret: z.string().min(1),
    nativeCredentials: nativeCredentialsSchema,
  }),
  deployments: z.array(
    z.object({
      problemId: z.string().min(1),
      launchToken: z.string().min(1),
      outputs: z.record(z.string(), z.string()),
    }),
  ),
});

function assertLauncherPrivatePaths(
  sessionPath: string,
  record: SimulatorSessionRecord,
): SimulatorSessionRecord {
  const { ownershipLeasePath, registrationPath } = record.launcher;
  if (
    (record.launcher.childPid === undefined) !==
      (record.launcher.childProcessIdentity === undefined) ||
    (record.launcher.childPid !== undefined && record.launcher.kind !== "process")
  ) {
    throw new Error("Recorded Simulator launcher contains an incomplete child identity");
  }
  if (
    record.launcher.launchIntentPath !== undefined &&
    resolve(record.launcher.launchIntentPath) !==
      resolve(join(dirname(sessionPath), "simulator-launch-intent.json"))
  ) {
    throw new Error("Recorded Simulator launcher contains an invalid launch intent path");
  }
  if (ownershipLeasePath === undefined && registrationPath === undefined) return record;
  const registrationName = registrationPath ? basename(registrationPath) : "";
  const match = /^simulator-launch-([0-9a-f-]{36})\.json$/i.exec(registrationName);
  if (
    record.launcher.kind !== "process" ||
    !ownershipLeasePath ||
    !registrationPath ||
    resolve(dirname(registrationPath)) !== resolve(dirname(sessionPath)) ||
    resolve(dirname(ownershipLeasePath)) !== resolve(dirname(sessionPath)) ||
    !match ||
    basename(ownershipLeasePath) !== `simulator-launch-${match[1]}.lease`
  ) {
    throw new Error("Recorded Simulator launcher contains invalid private ownership paths");
  }
  return record;
}

export function simulatorSessionSecretPath(sessionPath: string): string {
  return join(dirname(sessionPath), "simulator-secrets.json");
}

function publicConsoleBaseUrl(
  deployment: SimulatorSessionDeploymentRecord,
  launcherBaseUrl: string,
): string {
  const consoleUrl = new URL(deployment.consoleUrl);
  const expectedFragment = new URLSearchParams({ token: deployment.launchToken }).toString();
  if (consoleUrl.search || consoleUrl.hash !== `#${expectedFragment}`) {
    throw new Error("Simulator console URL must contain only its issued launch token fragment");
  }
  consoleUrl.hash = "";
  const verified = new URL(simulatorConsoleUrl(consoleUrl.toString(), "redacted", launcherBaseUrl));
  verified.hash = "";
  return verified.toString();
}

function publicSessionRecord(
  recordId: string,
  record: SimulatorSessionRecord,
): SimulatorPublicSessionRecord {
  return {
    protocolVersion: record.protocolVersion,
    recordId,
    launcher: {
      kind: record.launcher.kind,
      baseUrl: record.launcher.baseUrl,
      ...(record.launcher.pid === undefined ? {} : { pid: record.launcher.pid }),
      ...(record.launcher.processIdentity === undefined
        ? {}
        : { processIdentity: record.launcher.processIdentity }),
      ...(record.launcher.containerName === undefined
        ? {}
        : { containerName: record.launcher.containerName }),
    },
    deployments: record.deployments.map((deployment) => ({
      problemId: deployment.problemId,
      worldId: deployment.worldId,
      deploymentId: deployment.deploymentId,
      status: deployment.status,
      consoleBaseUrl: publicConsoleBaseUrl(deployment, record.launcher.baseUrl),
      clockObservedAtMs: deployment.clockObservedAtMs,
    })),
    ...(record.pendingWorldCreates && record.pendingWorldCreates.length > 0
      ? {
          pendingWorldCreates: record.pendingWorldCreates.map(({ problemId, deploymentId }) => ({
            problemId,
            deploymentId,
          })),
        }
      : {}),
    ...(record.pendingSnapshotRestores && record.pendingSnapshotRestores.length > 0
      ? {
          pendingSnapshotRestores: record.pendingSnapshotRestores.map(
            ({ problemId, deploymentId, sourceWorldId, snapshotHash, restoredWorldId }) => ({
              problemId,
              deploymentId,
              sourceWorldId,
              snapshotHash,
              ...(restoredWorldId ? { restoredWorldId } : {}),
            }),
          ),
        }
      : {}),
    ...(record.launcherNeedsReplacement ? { launcherNeedsReplacement: true } : {}),
  } satisfies SimulatorPublicSessionRecord;
}

export interface SimulatorSessionWriteHooks {
  readonly beforeSecretCommit?: () => void;
  readonly afterSecretCommit?: () => void;
  readonly beforePublicCommit?: () => void;
}

export function writeSimulatorSessionRecord(
  sessionPath: string,
  record: SimulatorSessionRecord,
  hooks: SimulatorSessionWriteHooks = {},
): void {
  const validated = assertLauncherPrivatePaths(
    sessionPath,
    sessionSchema.parse(record) satisfies SimulatorSessionRecord,
  );
  const recordId = randomUUID();
  const secrets = {
    protocolVersion: validated.protocolVersion,
    recordId,
    session: validated,
  } satisfies SimulatorSessionSecretsRecord;
  const publicRecord = publicSessionRecord(recordId, validated);

  // The protected half is a self-contained atomic generation. If the process
  // dies before the public projection commits, the reader can rebuild it.
  hooks.beforeSecretCommit?.();
  writePrivateJson(simulatorSessionSecretPath(sessionPath), secrets);
  hooks.afterSecretCommit?.();
  hooks.beforePublicCommit?.();
  writePrivateJson(sessionPath, publicRecord);
}

function readPublicRecord(sessionPath: string): unknown | undefined {
  if (!existsSync(sessionPath)) return undefined;
  try {
    return readPrivateJson<unknown>(sessionPath);
  } catch {
    return undefined;
  }
}

function restoreLegacySplitRecord(
  publicRecord: SimulatorPublicSessionRecord,
  secrets: z.infer<typeof legacySplitSecretsSchema>,
): SimulatorSessionRecord {
  if (publicRecord.recordId !== secrets.recordId) {
    throw new Error("Recorded Simulator session and secret record IDs do not match");
  }
  const secretByProblem = new Map(
    secrets.deployments.map((deployment) => [deployment.problemId, deployment]),
  );
  if (
    secretByProblem.size !== secrets.deployments.length ||
    publicRecord.deployments.length !== secrets.deployments.length
  ) {
    throw new Error("Recorded Simulator session and secret deployment sets do not match");
  }
  const launcher: SimulatorLauncherRecord = {
    ...publicRecord.launcher,
    launchSecret: secrets.launcher.launchSecret,
    nativeCredentials: secrets.launcher.nativeCredentials,
  };
  const deployments = publicRecord.deployments.map((deployment) => {
    const secret = secretByProblem.get(deployment.problemId);
    if (!secret) {
      throw new Error("Recorded Simulator session and secret deployment sets do not match");
    }
    secretByProblem.delete(deployment.problemId);
    return {
      ...deployment,
      launchToken: secret.launchToken,
      outputs: secret.outputs,
      consoleUrl: simulatorConsoleUrl(
        deployment.consoleBaseUrl,
        secret.launchToken,
        launcher.baseUrl,
      ),
      nativeCredentials: launcher.nativeCredentials,
    } satisfies SimulatorSessionDeploymentRecord;
  });
  if (secretByProblem.size > 0) {
    throw new Error("Recorded Simulator session and secret deployment sets do not match");
  }
  return {
    protocolVersion: SIMULATOR_PROTOCOL_VERSION,
    launcher,
    deployments,
    ...(publicRecord.launcherNeedsReplacement ? { launcherNeedsReplacement: true } : {}),
  };
}

export function readSimulatorSessionRecord(sessionPath: string): SimulatorSessionRecord {
  const secretPath = simulatorSessionSecretPath(sessionPath);
  const rawPublicRecord = readPublicRecord(sessionPath);
  if (existsSync(secretPath)) {
    const rawSecrets = readPrivateJson<unknown>(secretPath);
    const envelope = secretEnvelopeSchema.safeParse(rawSecrets);
    if (envelope.success) {
      const record = assertLauncherPrivatePaths(
        sessionPath,
        envelope.data.session satisfies SimulatorSessionRecord,
      );
      const expectedPublic = publicSessionRecord(envelope.data.recordId, record);
      const currentPublic = publicSessionSchema.safeParse(rawPublicRecord);
      if (
        !currentPublic.success ||
        JSON.stringify(currentPublic.data) !== JSON.stringify(expectedPublic)
      ) {
        writePrivateJson(sessionPath, expectedPublic);
      }
      return record;
    }

    const publicRecord = publicSessionSchema.safeParse(rawPublicRecord);
    const legacySecrets = legacySplitSecretsSchema.safeParse(rawSecrets);
    if (publicRecord.success && legacySecrets.success) {
      const migrated = restoreLegacySplitRecord(publicRecord.data, legacySecrets.data);
      writeSimulatorSessionRecord(sessionPath, migrated);
      return migrated;
    }
  }

  const legacy = sessionSchema.safeParse(rawPublicRecord);
  if (legacy.success) {
    const migrated = legacy.data satisfies SimulatorSessionRecord;
    writeSimulatorSessionRecord(sessionPath, migrated);
    return migrated;
  }
  throw new Error("Recorded Simulator session has no recoverable protected generation");
}
