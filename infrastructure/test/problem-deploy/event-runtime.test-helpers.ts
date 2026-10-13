import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { vi } from "vitest";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeFakeDdb } from "./control-data/control-data-write.test-helpers";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/** Actual selected runtime and file-mode libSQL; external SSM/DynamoDB are test adapters. */
export function eventRuntimeFixture(backend: "dynamodb" | "turso") {
  const client = createClient({ url: "file::memory:" });
  const runtime = makeTestControlDataRuntime(
    backend === "turso"
      ? {
          CONTROL_DATA_BACKEND: "turso",
          TURSO_DATABASE_URL: "libsql://fixture.invalid",
          TURSO_AUTH_TOKEN_PARAMETER_NAME: "/fixture/token",
        }
      : {},
    {
      ssm: {
        send: vi
          .fn()
          .mockResolvedValue({ Parameter: { Type: "SecureString", Value: randomUUID() } }),
      },
      createClient: () => client,
    },
  );
  const shared = {
    runtime,
    ddb: makeFakeDdb(),
    eventsTableName: "Events",
    teamsTableName: "Teams",
    deploymentsTableName: "Deployments",
  } as unknown as EventSharedResources;
  return { shared, runtime, close: () => client.close() };
}
