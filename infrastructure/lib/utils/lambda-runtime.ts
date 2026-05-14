import { Runtime } from "aws-cdk-lib/aws-lambda";

/** Shared Node.js runtime version for all Lambda functions in this project. */
export const LAMBDA_NODEJS_RUNTIME = Runtime.NODEJS_22_X;

/** esbuild `target` aligned with `LAMBDA_NODEJS_RUNTIME`. */
export const LAMBDA_NODEJS_BUNDLING_TARGET = "node22" as const;
