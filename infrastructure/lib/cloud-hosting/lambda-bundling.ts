import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BundlingOptions } from "aws-cdk-lib/aws-lambda-nodejs";

/** Bundle the HTTP libSQL transport with Node 24's native WebSocket compatibility export. */
export function cloudLambdaBundling(): BundlingOptions {
  const resolve = createRequire(import.meta.url).resolve;
  return {
    bundleAwsSDK: true,
    minify: true,
    target: "node24",
    mainFields: ["module", "main"],
    esbuildArgs: {
      // Hrana's HTTP barrel imports its WebSocket adapter eagerly. The package's
      // official native export avoids bundling the unused ws implementation.
      "--alias:@libsql/isomorphic-ws": join(dirname(resolve("@libsql/isomorphic-ws")), "web.mjs"),
    },
  };
}
