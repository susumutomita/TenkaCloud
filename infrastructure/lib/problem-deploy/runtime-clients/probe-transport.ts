import * as dns from "node:dns";
import type { IncomingMessage } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isSsrfSafeHost, isSsrfSafeUrl } from "./ssrf-guard.js";

/** The answers returned here are the addresses handed directly to the socket, not a preflight. */
export const pinnedProbeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, answers) => {
    if (error) return callback(error, "", 4);
    if (
      answers.length === 0 ||
      answers.some(({ address, family }) => isIP(address) !== family || !isSsrfSafeHost(address))
    ) {
      return callback(new Error("Unsafe probe DNS answer"), "", 4);
    }
    // net.connect may ask for all answers for IPv4/IPv6 fallback. Every returned answer was checked.
    if (options.all) callback(null, answers);
    else {
      const answer = answers.find((entry) => !options.family || entry.family === options.family);
      if (!answer) return callback(new Error("No matching probe DNS answer"), "", 4);
      callback(null, answer.address, answer.family);
    }
  });
};

function responseBody(response: IncomingMessage): ReadableStream<Uint8Array> {
  const encoding = response.headers["content-encoding"];
  const decoder = createResponseDecoder(encoding);
  // Node and Bun expose the same web stream at runtime but their DOM/BYOB declarations differ.
  if (!decoder) return Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
  // Cancelling a capped web body must also close the original HTTP socket.
  response.on("error", (error) => decoder.destroy(error));
  decoder.on("close", () => response.destroy());
  return Readable.toWeb(response.pipe(decoder)) as unknown as ReadableStream<Uint8Array>;
}

/** One HTTP hop, with the original hostname retained for Host, TLS SNI and certificate checks. */
function pinnedFetch(value: string, init: RequestInit): Promise<Response> {
  if (!isSsrfSafeUrl(value)) return Promise.reject(new Error("Unsafe probe URL"));
  const url = new URL(value);
  if (url.username || url.password) return Promise.reject(new Error("Probe URL contains userinfo"));
  const request = url.protocol === "https:" ? https.request : http.request;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method,
        headers: { "accept-encoding": "identity", ...headers },
        signal: init.signal ?? undefined,
        lookup: pinnedProbeLookup,
        // No pooled socket can bypass this hop's validation, and no environment proxy resolves instead.
        agent: false,
      },
      (res) => {
        try {
          resolve(toProbeResponse(res));
        } catch (error) {
          res.destroy();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end(typeof init.body === "string" ? init.body : undefined);
  });
}

/** Explicit transport boundary for scoring-kernel tests; production always uses pinnedFetch. */
export const probeTransport = { fetch: pinnedFetch };

function toProbeResponse(res: IncomingMessage): Response {
  const status = res.statusCode ?? 500;
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value !== undefined)
      responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  if ([204, 205, 304].includes(status)) {
    res.destroy();
    return new Response(null, { status, headers: responseHeaders });
  }
  return new Response(responseBody(res), { status, headers: responseHeaders });
}

function createResponseDecoder(encoding: string | string[] | undefined) {
  switch (encoding) {
    case "gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return undefined;
  }
}
