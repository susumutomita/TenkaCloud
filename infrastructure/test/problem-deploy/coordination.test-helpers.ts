import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { vi } from "vitest";
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
