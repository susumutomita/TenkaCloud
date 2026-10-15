import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { directWebTransport } from "../direct-web-transport";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(encoding: string, body: Buffer): Promise<URL> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": encoding });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
  return new URL(`http://127.0.0.1:${String(address.port)}/`);
}

test("precompressed published Web responses reach the proxy decoded", async () => {
  for (const [encoding, body] of [
    ["gzip", gzipSync("<h1>published</h1>")],
    ["br", brotliCompressSync("<h1>published</h1>")],
  ] as const) {
    const response = await directWebTransport(await serve(encoding, body), { method: "GET" });
    expect(await response.text()).toBe("<h1>published</h1>");
    expect(response.headers.get("content-encoding")).toBeNull();
  }
});

test("unknown encodings and oversized decoded bodies are refused instead of forwarded", async () => {
  await expect(
    directWebTransport(await serve("compress", Buffer.from("x")), { method: "GET" }),
  ).rejects.toThrow("Invalid published Web response.");
  await expect(
    directWebTransport(await serve("gzip", gzipSync(Buffer.alloc(3 * 1024 * 1024))), {
      method: "GET",
    }),
  ).rejects.toThrow("Invalid published Web response.");
});
