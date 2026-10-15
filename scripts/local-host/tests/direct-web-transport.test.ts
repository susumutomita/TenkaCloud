import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { directWebTransport } from "../direct-web-transport";
import { closeServer, listen } from "../http";

test("published Web transport requires literal HTTP endpoints and preserves bounded bodies and cookies", async () => {
  for (const value of [
    "http://localhost:8080",
    "https://127.0.0.1",
    "http://user:secret@127.0.0.1",
  ])
    await expect(directWebTransport(new URL(value), {})).rejects.toThrow(
      "Invalid published Web endpoint",
    );
  const server = createServer((req, res) => {
    if (req.url === "/oversize") {
      res.end(Buffer.alloc(2 * 1024 * 1024 + 1));
      return;
    }
    if (req.url === "/empty") {
      res.writeHead(204);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      res.writeHead(201, { "set-cookie": ["a=1; Path=/", "b=2; HttpOnly"] });
      res.end(body);
    });
  });
  const origin = await listen(server, "127.0.0.1", 0);
  try {
    const bytes = new TextEncoder().encode("literal transport body");
    const response = await directWebTransport(new URL(origin), {
      method: "POST",
      body: bytes.buffer,
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("literal transport body");
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; HttpOnly"]);
    expect((await directWebTransport(new URL("/empty", origin), {})).status).toBe(204);
    await expect(directWebTransport(new URL("/oversize", origin), {})).rejects.toThrow(
      "limit exceeded",
    );
  } finally {
    await closeServer(server);
  }
});
