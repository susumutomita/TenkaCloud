import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { createClient } from "@libsql/client/http";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";
import { cloudLambdaBundling } from "../../lib/cloud-hosting/lambda-bundling.js";
import { sqlHttpFixture } from "./sql-http-fixture.js";

it("runs the bundled official libSQL HTTP transport without the unused ws package", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-http-bundle-"));
  const fixture = sqlHttpFixture();
  const options = cloudLambdaBundling();
  const output = join(directory, "client.cjs");
  const nativeWebSocket = options.esbuildArgs?.["--alias:@libsql/isomorphic-ws"];
  if (typeof nativeWebSocket !== "string")
    throw new Error("Missing official native WebSocket export");
  expect(typeof globalThis.WebSocket).toBe("function");
  const result = buildSync({
    stdin: {
      contents: 'export { createClient } from "@libsql/client/http";',
      resolveDir: resolve(import.meta.dirname, "../../.."),
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    minify: options.minify,
    target: options.target,
    mainFields: options.mainFields,
    alias: { "@libsql/isomorphic-ws": nativeWebSocket },
    metafile: true,
  });
  expect(Object.keys(result.metafile.inputs).some((file) => /node_modules\/ws\//u.test(file))).toBe(
    false,
  );
  const bundled = createRequire(import.meta.url)(output) as { createClient: typeof createClient };
  const client = bundled.createClient({
    url: "https://fixture.invalid",
    authToken: "synthetic-token",
    fetch: fixture.fetch,
  });
  try {
    await client.execute("CREATE TABLE sample (id TEXT PRIMARY KEY, value INTEGER)");
    await client.batch(
      [
        { sql: "INSERT INTO sample VALUES (?, ?)", args: ["one", 7] },
        { sql: "UPDATE sample SET value = value + 1 WHERE id = ?", args: ["one"] },
      ],
      "write",
    );
    expect((await client.execute("SELECT value FROM sample")).rows[0]?.value).toBe(8);
    const transaction = await client.transaction("write");
    await transaction.execute("UPDATE sample SET value = 99");
    await transaction.rollback();
    expect((await client.execute("SELECT value FROM sample")).rows[0]?.value).toBe(8);
    expect(fixture.httpRequests.length).toBeGreaterThan(0);
  } finally {
    client.close();
    fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
