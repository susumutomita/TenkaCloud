/**
 * AWS Lambda handler entry.
 * Deploy target: API Gateway / Lambda Function URL.
 */
import { handle } from "hono/aws-lambda";
import { app } from "./app";

export const handler = handle(app);
