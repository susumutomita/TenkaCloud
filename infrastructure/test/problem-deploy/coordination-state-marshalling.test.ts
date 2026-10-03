import { createServer } from "node:http";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import type { CoordinationStateScope } from "../../lib/problem-deploy/control-data/domain/coordination-scope.js";
import { writeCoordinationState } from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

/**
 * [Battle on DynamoDB] A coordination row must survive the REAL DynamoDB
 * document marshaller, not a `send` double.
 *
 * Every other coordination suite injects a fake `ddb.send`, so the marshalling
 * middleware -- the layer that actually decides whether a plugin state can be
 * stored -- was never exercised. It is not a formality: with the default
 * `marshallOptions` the client REFUSES an explicit `undefined` property
 * anywhere in the item and throws out of the middleware, before any request is
 * sent. `ac26-crypto-battle` produces exactly that state from its first row
 * (`startedAtMs`, `nextContractAtMs`, each team's `lastRotateAtMs` are
 * `undefined` until the match starts), so on the DynamoDB backend every READY
 * and START threw and the match could never begin, while the same problem
 * played fine on Turso.
 *
 * These tests therefore run the production `DynamoDBDocumentClient` against a
 * local HTTP endpoint and read the bytes it put on the wire.
 */

/** The shape `ac26-crypto-battle.initialState` hands the host before a match starts. */
const WAITING_MATCH_STATE = {
  phase: "waiting",
  nowMs: 60_000,
  startedAtMs: undefined,
  nextContractAtMs: undefined,
  readyTeamIds: ["teamA"],
  teams: {
    teamA: { score: 0, lastRotateAtMs: undefined },
    teamB: { score: 0, lastRotateAtMs: undefined },
  },
} as const;

const SCOPE: CoordinationStateScope = {
  tenantId: "tenant1",
  eventId: "event1",
  problemId: "ac26-crypto-battle",
  runId: "run1",
};

/**
 * Runs `use` against a real document client whose requests are answered
 * locally, and hands back every request body DynamoDB would have received.
 */
async function withRecordingDynamoDb(
  use: (
    shared: ParticipantSharedResources,
    bodies: () => readonly Record<string, unknown>[],
  ) => Promise<void>,
): Promise<void> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "local",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
      maxAttempts: 1,
    }),
  );
  try {
    await use(
      {
        runtime: makeTestControlDataRuntime(),
        tableName: "Deployments",
        eventsTableName: "Events",
        endpointsTableName: "",
        ddb,
        problemsScoring: {},
        problemsEndpoints: {},
      } as unknown as ParticipantSharedResources,
      () => bodies,
    );
  } finally {
    ddb.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The `state` attribute of the Put inside the transaction this write emitted. */
function writtenState(body: Record<string, unknown>): unknown {
  const items = body.TransactItems as { Put?: { Item?: Record<string, unknown> } }[] | undefined;
  const item = items?.find((entry) => entry.Put)?.Put?.Item;
  if (!item) throw new Error("No Put in the transaction");
  return item.state;
}

describe("coordination state on the real DynamoDB document marshaller", () => {
  it("is the failure mode: an undefined property is refused before the request is sent", async () => {
    await withRecordingDynamoDb(async (shared, bodies) => {
      await expect(
        shared.ddb.send(
          new PutCommand({
            TableName: "Deployments",
            Item: { PK: "COORD#x", SK: "STATE", state: WAITING_MATCH_STATE },
          }),
        ),
      ).rejects.toThrow(/removeUndefinedValues/);
      // Nothing reached the wire: this is a client-side throw, which is why it
      // surfaced as a 500 with no DynamoDB error to point at.
      expect(bodies()).toHaveLength(0);
    });
  });

  it("writes a waiting match whose optional fields are still undefined", async () => {
    await withRecordingDynamoDb(async (shared, bodies) => {
      const outcome = await writeCoordinationState(
        shared,
        SCOPE,
        WAITING_MATCH_STATE,
        0,
        new Date("2026-01-01T00:00:00.000Z").toISOString(),
      );
      expect(outcome).toEqual({ kind: "ok" });
      const write = bodies().at(-1);
      expect(write).toBeDefined();
      // The undefined properties are dropped, exactly as `JSON.stringify` (and
      // therefore the SQL backend) already drops them. Everything else is
      // byte-identical to the plugin's own state.
      expect(writtenState(write as Record<string, unknown>)).toEqual({
        M: {
          phase: { S: "waiting" },
          nowMs: { N: "60000" },
          readyTeamIds: { L: [{ S: "teamA" }] },
          teams: {
            M: {
              teamA: { M: { score: { N: "0" } } },
              teamB: { M: { score: { N: "0" } } },
            },
          },
        },
      });
    });
  });
});
