import { createCloudDataCache } from "../../infrastructure/lib/problem-deploy/control-data/cloud-data";
import type { CloudDataRepository } from "../../infrastructure/lib/problem-deploy/control-data/cloud-data-ports";
import type { CloudTableNames } from "../../infrastructure/lib/problem-deploy/control-data/dynamodb-cloud-repository";
import type { InstallationScope } from "../../infrastructure/lib/problem-deploy/control-data/installation-control";
import { requestEventTeardown } from "../../infrastructure/lib/problem-deploy/handlers/cloud-api/deployment-routes";
import { createProductionNativeCoordination } from "../../infrastructure/lib/problem-deploy/handlers/cloud-api/native-production";

export interface CloudInstallation {
  readonly repository: Pick<
    CloudDataRepository,
    | "installationControl"
    | "assertAcceptingInstallation"
    | "stopAcceptingInstallation"
    | "listStoppedInstallationEvents"
    | "confirmInstallationDrained"
  >;
  requestEventTeardown(eventId: string, now: number): Promise<{ readonly failed: number }>;
  close(): void;
}
export interface InstallationLocation {
  readonly region: string;
  readonly tables?: CloudTableNames;
  readonly backend?: "dynamodb" | "turso";
  readonly turso?: {
    readonly databaseUrl: string;
    readonly authTokenParameterName: string;
  };
  readonly native?: {
    readonly artifactBucket: string;
    readonly catalogKey: string;
    readonly expectedBucketOwner: string;
  };
}
/** Uses the same operator credential chain as the CLI; never accepts alternate service endpoints. */
export async function openCloudInstallation(
  location: InstallationLocation,
): Promise<CloudInstallation> {
  const data = await createCloudDataCache({
    region: location.region,
    tables: location.tables,
    env: {
      CONTROL_DATA_BACKEND: location.backend,
      TURSO_DATABASE_URL: location.turso?.databaseUrl,
      TURSO_AUTH_TOKEN_PARAMETER_NAME: location.turso?.authTokenParameterName,
    },
  })();
  const { repository, work } = data;
  const native = location.native
    ? createProductionNativeCoordination({
        repository,
        store: data.coordination,
        region: location.region,
        ...location.native,
      })
    : undefined;
  return {
    repository,
    requestEventTeardown: async (eventId, now) =>
      (
        await requestEventTeardown({
          repository,
          work,
          eventId,
          now,
          ...(native ? { beforeClose: () => native.closeEvent(eventId, now) } : {}),
        })
      ).body,
    close: () => data.close(),
  };
}

/** Durable stop precedes discovery. Cleanup is the existing event/SFN path, never a global AWS scan. */
export async function drainInstallation(
  installation: CloudInstallation,
  scope: InstallationScope,
  io: {
    readonly stdout: (text: string) => void;
    readonly now: () => number;
    readonly wait: (ms: number) => Promise<void>;
  },
  timeoutMs = 30 * 60_000,
): Promise<void> {
  const started = io.now();
  await installation.repository.stopAcceptingInstallation(scope, new Date(started).toISOString());
  const events = await installation.repository.listStoppedInstallationEvents(scope);
  io.stdout(
    `[cloud] New work stopped. Draining ${events.length} stored events before platform removal.\n`,
  );
  let failed = 0;
  for (const event of events) {
    try {
      const result = await installation.requestEventTeardown(event.eventId, io.now());
      failed += result.failed;
    } catch {
      failed++;
      io.stdout(
        `[cloud] Event ${event.eventId} could not enqueue all cleanup; its evidence and resources remain available.\n`,
      );
    }
  }
  if (failed > 0)
    throw new Error(
      `Cleanup acceptance failed for ${failed} targets or events. Platform retained and new work remains stopped. Review event diagnostics, then repeat the same teardown command to resume.`,
    );
  for (;;) {
    const current = await installation.repository.listStoppedInstallationEvents(scope);
    if (
      current.every(
        (event) =>
          event.status === "ARCHIVED" &&
          event.teardownExpected !== undefined &&
          event.teardownExpected === event.teardownCompleted,
      )
    ) {
      await installation.repository.confirmInstallationDrained(
        scope,
        new Date(io.now()).toISOString(),
      );
      io.stdout(
        "[cloud] All recorded event targets are drained; tournament scores and receipts are retained.\n",
      );
      return;
    }
    if (io.now() - started >= timeoutMs)
      throw new Error(
        "Cleanup is still pending. Platform retained and new work remains stopped. Check event diagnostics and repeat the same teardown command to resume; no timeout reopens the installation.",
      );
    await io.wait(5_000);
  }
}
