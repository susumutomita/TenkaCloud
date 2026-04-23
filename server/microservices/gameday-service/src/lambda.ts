/**
 * AWS Lambda handler entry.
 * Note: the local auditor setInterval loop does not run on Lambda — it should be
 * migrated to EventBridge Scheduler + a dedicated Lambda in a follow-up.
 */
import { handle } from "hono/aws-lambda";
import { app } from "./app";

export const handler = handle(app);
