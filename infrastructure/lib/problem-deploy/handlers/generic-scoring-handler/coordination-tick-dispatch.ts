import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { CoordinationTickBatch } from "../shared/coordination-tick-contract.js";

/**
 * scoring-driven tick Issue #2324: 採点 pass → CoordinationDispatcher Lambda の直接 Invoke client。
 *
 * `handler-no-direct-sdk-import` は `handlers/**\/index.ts` だけを検査する。 SDK client (= LambdaClient)
 * は本 service module に閉じ込め、 handler index.ts へは注入可能な {@link CoordinationTickInvoker}
 * 関数として渡す (= index.ts を routing 専任に保つ / test で mock 可能)。
 */

/** dispatcher を 1 tick batch で async Invoke する関数 (= test では fake を注入)。 */
export type CoordinationTickInvoker = (
  functionName: string,
  batch: CoordinationTickBatch,
) => Promise<void>;

/**
 * 本番用 factory: LambdaClient を構築し、 dispatcher を `InvocationType=Event` (= async fire-and-forget)
 * で Invoke する invoker を返す。 応答は待たない (= tick 結果は次 tick が shared row を読んで反映する。
 * 採点 pass を dispatcher の実行時間で待たせない)。 payload は wire contract の JSON。
 */
export function createLambdaTickInvoker(): CoordinationTickInvoker {
  const client = new LambdaClient({});
  return async (functionName, batch) => {
    // Each scope gets the dispatcher's full invocation lifetime. Bound outbound fan-out;
    // failures remain visible and the next scoring pass retries the same scoped targets.
    let failure: unknown;
    for (let offset = 0; offset < batch.targets.length; offset += 4) {
      const results = await Promise.allSettled(
        batch.targets.slice(offset, offset + 4).map((target) =>
          client.send(
            new InvokeCommand({
              FunctionName: functionName,
              InvocationType: "Event",
              Payload: Buffer.from(JSON.stringify({ ...batch, targets: [target] })),
            }),
          ),
        ),
      );
      failure ??= results.find((result) => result.status === "rejected")?.reason;
    }
    if (failure !== undefined) throw failure;
  };
}
