import { mkdtempSync, writeFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage, request, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";

import { createLocalApiProxyMiddleware, LOCAL_API_PROXY_PREFIX } from "../local-play-proxy";

describe("Codespaces local Participant API proxy upstream fallback", () => {
  it("should use Bad Gateway when an upstream response omits its status", async () => {
    const requestMock = vi.fn();
    requestMock.mockImplementation(
      (_options: unknown, onResponse: (response: IncomingMessage) => void): ClientRequest => {
        const outgoing = new PassThrough();
        queueMicrotask(() => {
          const upstream = Object.assign(new PassThrough(), {
            headers: {},
            statusCode: undefined,
          }) as PassThrough & IncomingMessage;
          onResponse(upstream);
          upstream.end("fallback");
        });
        return outgoing as unknown as ClientRequest;
      },
    );

    const directory = mkdtempSync(join(tmpdir(), "tc-local-api-proxy-upstream-"));
    const statePath = join(directory, "state.json");
    writeFileSync(statePath, JSON.stringify({ apiBaseUrl: "http://127.0.0.1:43199" }));
    const middleware = createLocalApiProxyMiddleware({
      statePath,
      request: requestMock as unknown as typeof request,
    });
    const incoming = Object.assign(new PassThrough(), {
      headers: {},
      method: "GET",
      url: `${LOCAL_API_PROXY_PREFIX}/healthz`,
    }) as PassThrough & IncomingMessage;
    let accept!: () => void;
    const done = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const response = {
      headersSent: false,
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(accept),
    } as unknown as ServerResponse;

    middleware(incoming, response, vi.fn());
    incoming.end();
    await done;

    expect(requestMock).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(StatusCodes.BAD_GATEWAY);
  });
});
