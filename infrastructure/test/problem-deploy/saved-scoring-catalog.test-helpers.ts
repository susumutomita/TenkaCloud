import type { S3Client } from "@aws-sdk/client-s3";
import type { GenericScoringSharedResources } from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared.js";
import {
  contentDigest,
  createCatalogLoader,
  type ExecutionCatalog,
} from "../../lib/problem-deploy/handlers/shared/execution-catalog.js";

/** Real integrity reader over immutable local fixture bytes; no mutable-catalog fallback. */
export function createSavedScoringFixture() {
  const artifacts = new Map<string, Uint8Array>();
  let catalogKey: string | undefined;
  const s3 = {
    send: async (command: { input: { Key?: string } }) => {
      const bytes = artifacts.get(command.input.Key ?? "");
      if (!bytes) throw new Error("Saved scoring fixture artifact missing");
      return {
        ContentLength: bytes.byteLength,
        Body: {
          transformToWebStream: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
        },
      };
    },
  };
  const loadCatalog = createCatalogLoader({
    artifactBucket: "scoring-fixture-artifacts",
    s3: s3 as unknown as Pick<S3Client, "send">,
  });
  return {
    get catalogKey() {
      if (!catalogKey) throw new Error("Scoring fixture must publish before deployment discovery");
      return catalogKey;
    },
    attach(shared: GenericScoringSharedResources): GenericScoringSharedResources {
      const catalog: ExecutionCatalog = {
        version: 1,
        catalog: { "hello-world": "hello-world", "hello-world-battle": "hello-world-battle" },
        scoring: shared.problemsScoring,
        endpoints: shared.problemsEndpoints,
        disruptions: shared.problemsDisruptions,
        phases: {},
        hints: {},
        visibility: {},
        runtimes: {},
        writeups: {},
        provenance: {},
        coordination: {},
        plugins: {},
        sources: {},
        sourceArchive: { bucket: "fixture-sources", key: "archive.zip", versionId: "saved-A" },
      };
      const bytes = Buffer.from(JSON.stringify(catalog));
      catalogKey = `catalogs/${contentDigest(bytes)}.json`;
      artifacts.set(catalogKey, bytes);
      return {
        ...shared,
        catalogLoader: async (key) => {
          if (!key) throw new Error("Saved scoring fixture requires an explicit pin");
          return loadCatalog(key);
        },
      };
    },
    eventRead(command: unknown, overrides: Record<string, unknown> = {}) {
      const candidate = command as {
        constructor: { name: string };
        input?: { TableName?: string; ConsistentRead?: boolean };
      };
      if (
        candidate.constructor.name !== "GetCommand" ||
        candidate.input?.TableName !== "TestEvents"
      )
        return undefined;
      if (candidate.input.ConsistentRead !== true)
        throw new Error("Saved event requires an authoritative read");
      if (!catalogKey) throw new Error("Saved event requires a published fixture catalog");
      return {
        Item: {
          tenantId: "tenant-acme",
          eventId: "event-1",
          catalogKey,
          status: "RUNNING",
          scoringLocked: false,
          startsAt: "2026-05-12T09:00:00.000Z",
          ...overrides,
        },
      };
    },
  };
}
