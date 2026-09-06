import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createClient } from "@libsql/client/http";
import { createControlDataRuntime } from "../../control-data/runtime-repositories.js";

/** A saved score delivery retries on the next tick, not in unbounded SDK backoff. */
export const SCORE_DELIVERY_REQUEST_TIMEOUT_MS = 750;
const requestHandler = {
  connectionTimeout: 500,
  requestTimeout: SCORE_DELIVERY_REQUEST_TIMEOUT_MS,
  // Smithy otherwise only warns when requestTimeout elapses.
  throwOnRequestTimeout: true,
};

export function createScoreDeliveryDdbClient(config: DynamoDBClientConfig = {}) {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ ...config, maxAttempts: 1, requestHandler }),
  );
}

export async function scoreDeliveryFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const original = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const timeout = AbortSignal.timeout(SCORE_DELIVERY_REQUEST_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: original ? AbortSignal.any([original, timeout]) : timeout,
  });
}

/** Only durable score delivery may use these limits; participant state writes must not. */
export function createScoreDeliveryControlDataRuntime() {
  return createControlDataRuntime({
    env: process.env,
    ssm: new SSMClient({ maxAttempts: 1, requestHandler }),
    createClient: (config) => createClient({ ...config, fetch: scoreDeliveryFetch }),
  });
}
