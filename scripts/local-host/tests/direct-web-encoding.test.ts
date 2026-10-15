import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { directWebTransport } from "../direct-web-transport";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(
  respond: (acceptEncoding: string | undefined) => {
    headers: Record<string, string>;
    body: Buffer;
  },
): Promise<URL> {
  const server = createServer((request, response) => {
    const { headers, body } = respond(request.headers["accept-encoding"]);
    response.writeHead(200, { "content-type": "text/html", ...headers });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
  return new URL(`http://127.0.0.1:${String(address.port)}/`);
}

test("published Web requests ask for an unencoded body and forward it unchanged", async () => {
  const url = await serve((acceptEncoding) => ({
    headers: {},
    body: Buffer.from(`accept-encoding=${String(acceptEncoding)}`),
  }));
  const response = await directWebTransport(url, { method: "GET" });
  expect(await response.text()).toBe("accept-encoding=identity");
});

test("an encoded body is refused instead of being decoded on the controller or forwarded garbled", async () => {
  const url = await serve(() => ({
    headers: { "content-encoding": "gzip" },
    body: gzipSync("<h1>published</h1>"),
  }));
  await expect(directWebTransport(url, { method: "GET" })).rejects.toThrow(
    "Invalid published Web response.",
  );
});
