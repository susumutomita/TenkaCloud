import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";

/** Shared HTTP transport only: persistence, authentication and execution belong to the application. */
export function createHttpServer(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  onError: (response: ServerResponse, error: unknown) => void,
): Server {
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => onError(response, error));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 40;
  server.setTimeout(15_000, (socket) => socket.destroy());
  return server;
}

/** Resolve the AWS bind explicitly; local callers keep their own independent listener settings. */
export function httpEndpoint(value: string | undefined): { hostname: string; port: number } {
  if (value === undefined) return { hostname: "127.0.0.1", port: 3000 };
  const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):(\d+)$/u.exec(value);
  const hostname = match?.[1]?.replace(/^\[|\]$/gu, "");
  const port = Number(match?.[2]);
  if (!hostname || port < 1 || port > 65535 || (hostname.includes(":") && isIP(hostname) !== 6))
    throw new Error("AWS_LAMBDA_HTTP_ENDPOINT must be host:port with a port from 1 to 65535.");
  return { hostname, port };
}

export async function listen(server: Server, hostname: string, port: number): Promise<string> {
  await new Promise<void>((accept, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, hostname, () => {
      server.off("error", failed);
      accept();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The HTTP server has no TCP address.");
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${host}:${address.port}`;
}

export async function closeServer(server: Server): Promise<void> {
  // Bun closeAllConnections also stops an upgraded listener; do not close it twice.
  if (!server.listening) return;
  server.closeIdleConnections();
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
}
