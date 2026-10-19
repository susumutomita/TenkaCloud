import assert from "node:assert/strict";
import { createServer } from "node:net";
import { closeServer, createHttpServer, httpEndpoint, listen } from "./node-http.ts";

// Runs under Node's native TypeScript stripping, independent of Bun and the Local host providers.
assert.equal(process.versions.node.split(".")[0], "24");
assert.deepEqual(httpEndpoint(undefined), { hostname: "127.0.0.1", port: 3000 });
assert.deepEqual(httpEndpoint("[::1]:1234"), { hostname: "::1", port: 1234 });
for (const value of [
  "",
  "127.0.0.1",
  "127.0.0.1:0",
  "127.0.0.1:65536",
  "localhost:no",
  "http://localhost:3000",
  "[:::]:3000",
])
  assert.throws(() => httpEndpoint(value));

const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const reserved = reservation.address();
assert.ok(reserved && typeof reserved !== "string");
process.env.AWS_LAMBDA_HTTP_ENDPOINT = `127.0.0.1:${String(reserved.port)}`;
const endpoint = httpEndpoint(process.env.AWS_LAMBDA_HTTP_ENDPOINT);
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const errors: unknown[] = [];
const server = createHttpServer(
  async (request, response) => {
    if (request.url === "/error") throw new Error("private detail");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: request.url }));
  },
  (response, error) => {
    errors.push(error);
    response.writeHead(500);
    response.end("internal_error");
  },
);
try {
  const origin = await listen(server, endpoint.hostname, endpoint.port);
  assert.equal(origin, `http://${process.env.AWS_LAMBDA_HTTP_ENDPOINT}`);
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, index) => fetch(`${origin}/request-${String(index)}`)),
  );
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: `/request-${String(index)}` });
  }
  const error = await fetch(`${origin}/error`);
  assert.equal(error.status, 500);
  assert.equal(await error.text(), "internal_error");
  assert.equal(errors.length, 1);
  const recovered = await fetch(`${origin}/after-error`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { path: "/after-error" });
  const occupied = createHttpServer(
    async (_request, response) => {
      response.end();
    },
    () => assert.fail(),
  );
  await assert.rejects(listen(occupied, endpoint.hostname, endpoint.port), { code: "EADDRINUSE" });
} finally {
  await closeServer(server);
  await closeServer(server);
}
// Listener restart reuses the endpoint in this process; it does not test cold-start state recovery.
await listen(server, endpoint.hostname, endpoint.port);
await closeServer(server);
console.log("Node 24 HTTP transport, endpoint, concurrency, error, bind failure and restart: PASS");
