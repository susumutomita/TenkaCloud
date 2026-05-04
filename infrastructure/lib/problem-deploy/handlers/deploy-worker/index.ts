import type { EventBridgeEvent } from "aws-lambda";
import { DeployRequestedDetailSchema } from "./types.js";
import { buildWorkerShared, handleDeployRequested } from "./worker.js";

const shared = buildWorkerShared();

export const handler = async (
  event: EventBridgeEvent<"DeployRequested", unknown>,
): Promise<void> => {
  const parsed = DeployRequestedDetailSchema.safeParse(event.detail);
  if (!parsed.success) {
    console.error("[worker] invalid DeployRequested detail", {
      issues: parsed.error.issues,
    });
    throw new Error("invalid event detail");
  }
  await handleDeployRequested(shared, parsed.data);
};
