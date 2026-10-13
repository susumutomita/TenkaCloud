import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("portable transport starts under Node 24 at AWS_LAMBDA_HTTP_ENDPOINT and survives errors/restart", () => {
  const result = spawnSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- verify the real Node toolchain required by mise.toml and CI.
    "node",
    [fileURLToPath(new URL("./node-http.test-helpers.ts", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "Node 24 HTTP transport, endpoint, concurrency, error, bind failure and restart: PASS",
  );
});
