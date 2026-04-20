/**
 * AWS Lambda handler entry.
 * Note: the reconcile() job that runs on startup is server.ts-only; on Lambda
 * it should be migrated to EventBridge Scheduler + a dedicated handler.
 */
import { handle } from "hono/aws-lambda";
import { app } from "./routes";

export const handler = handle(app);
