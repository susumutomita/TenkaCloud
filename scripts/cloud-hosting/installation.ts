import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { CloudTableNames } from "../../infrastructure/lib/problem-deploy/control-data/dynamodb-cloud-repository";
import { DynamoCloudRepository } from "../../infrastructure/lib/problem-deploy/control-data/dynamodb-cloud-repository";
import { DynamoDeploymentWork } from "../../infrastructure/lib/problem-deploy/control-data/dynamodb-deployment-work";
import type { InstallationScope } from "../../infrastructure/lib/problem-deploy/control-data/installation-control";
import { requestEventTeardown } from "../../infrastructure/lib/problem-deploy/handlers/cloud-api/deployment-routes";

export interface CloudInstallation {
  readonly repository: Pick<
    DynamoCloudRepository,
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
  readonly tables: CloudTableNames;
}
/** Uses the same operator credential chain as the CLI; never accepts alternate service endpoints. */
export function openCloudInstallation(location: InstallationLocation): CloudInstallation {
  const client = new DynamoDBClient({
    region: location.region,
    ignoreConfiguredEndpointUrls: true,
  });
  const document = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const repository = new DynamoCloudRepository(document, location.tables);
  const work = new DynamoDeploymentWork(document, location.tables);
  return {
    repository,
    requestEventTeardown: async (eventId, now) =>
      (await requestEventTeardown({ repository, work, eventId, now })).body,
    close: () => client.destroy(),
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
