import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { vi } from "vitest";
import type { CoordinationArtifactStore } from "../../lib/problem-deploy/control-data/coordination-artifact-store.js";
import type { CoordinationArtifactBody } from "../../lib/problem-deploy/control-data/domain/coordination-artifact.js";
import type { CoordinationStateScope } from "../../lib/problem-deploy/control-data/domain/coordination-scope.js";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

/**
 * coordination の route/resolver test が使う {@link ParticipantSharedResources} の stub。
 *
 * `ddb` の stub は「`send` だけ持つ最小の double」なので、DocumentClient への cast が 1 箇所だけ
 * 要る。それをこのヘルパーに閉じ込め、各 test file が同じ cast を書き散らさないようにしている
 * (Issue #3053 で roster query 用の stub が増えたのが契機)。
 */
export function fakeParticipantShared(
  send: (...args: never[]) => Promise<unknown>,
): ParticipantSharedResources {
  const ddb = { send } as unknown as DynamoDBDocumentClient;
  return {
    runtime: makeTestControlDataRuntime(),
    tableName: "Deployments",
    eventsTableName: "Events",
    endpointsTableName: "",
    ddb,
    problemsScoring: {},
    problemsEndpoints: {},
  };
}

/** 何度呼ばれても同じ `Items` を返す {@link fakeParticipantShared}。 */
export function fakeParticipantSharedWithItems(
  items: readonly unknown[],
): ParticipantSharedResources {
  return fakeParticipantShared(vi.fn(async () => ({ Items: items })));
}

/**
 * [Issue #3152] An in-memory {@link CoordinationArtifactStore} for handler tests.
 *
 * The handler's artifact deps are REQUIRED rather than optional, so a test that
 * omitted them would only fail once a test actually submitted a body — and
 * `tsconfig.json` excludes `test/`, so the compiler would not have said so
 * either. One shared fake keeps every handler suite honest about that.
 */
export function fakeArtifactStore(): CoordinationArtifactStore & {
  readonly stored: Map<string, CoordinationArtifactBody>;
  readonly removed: string[];
  /** Set to make the next `put` report the scope as torn down. */
  scopeDeleted: boolean;
} {
  const stored = new Map<string, CoordinationArtifactBody>();
  const removed: string[] = [];
  let counter = 0;
  const fake = {
    stored,
    removed,
    scopeDeleted: false,
    put: (_scope: CoordinationStateScope, body: CoordinationArtifactBody) => {
      if (fake.scopeDeleted) return Promise.resolve({ kind: "scope_deleted" as const });
      const artifactId = `artifact${++counter}`;
      stored.set(artifactId, body);
      return Promise.resolve({
        kind: "stored" as const,
        ref: {
          artifactId,
          contentType: body.contentType,
          bytes: body.content.byteLength,
          digest: "d".repeat(64),
          writtenAtMs: 1,
        },
      });
    },
    get: (_scope: CoordinationStateScope, artifactId: string) => {
      const body = stored.get(artifactId);
      return Promise.resolve(
        body
          ? {
              content: body.content,
              ref: {
                artifactId,
                contentType: body.contentType,
                bytes: body.content.byteLength,
                digest: "d".repeat(64),
                writtenAtMs: 1,
              },
            }
          : undefined,
      );
    },
    remove: (_scope: CoordinationStateScope, artifactId: string) => {
      removed.push(artifactId);
      stored.delete(artifactId);
      return Promise.resolve();
    },
    deleteScope: () => Promise.resolve(stored.size),
  };
  return fake;
}
