import * as dns from "node:dns";
import type { IncomingMessage } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable, type Transform } from "node:stream";
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
  const header = response.headers["content-encoding"];
  const codings = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((coding) => coding.trim().toLowerCase());
  // Like fetch, leave a response with an unsupported coding untouched; never decode only part.
  if (!codings.every(isSupportedCoding)) return toWebBody(response);
  // Bound native decoder allocations before reading an untrusted response body.
  if (codings.length > 16) throw new Error("Too many probe content encodings");
  codings.reverse();
  const decoders = codings.map(createResponseDecoder);
  const last = decoders[decoders.length - 1];
  if (!last) return toWebBody(response);
  // Attach web error/cancellation handling before starting the native pipeline. pipeline propagates
  // failures and cancellation through every decoder and destroys the original HTTP socket.
  const body = toWebBody(last);
  pipeline([response, ...decoders], (error) => {
    if (error) last.destroy(error);
  });
  return body;
}

function toWebBody(stream: Readable): ReadableStream<Uint8Array> {
  // Node and Bun expose the same web stream but their DOM/BYOB declarations differ.
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

type SupportedCoding = "gzip" | "x-gzip" | "deflate" | "br";
function isSupportedCoding(coding: string): coding is SupportedCoding {
  return ["gzip", "x-gzip", "deflate", "br"].includes(coding);
}

// Fetch Standard bad-port table: https://fetch.spec.whatwg.org/#port-blocking
// Preserve the old Node fetch boundary before constructing any native request.
const FETCH_FORBIDDEN_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** One HTTP hop, with the original hostname retained for Host, TLS SNI and certificate checks. */
function pinnedFetch(value: string, init: RequestInit): Promise<Response> {
  if (!isSsrfSafeUrl(value)) return Promise.reject(new Error("Unsafe probe URL"));
  const url = new URL(value);
  if (url.port !== "" && FETCH_FORBIDDEN_PORTS.has(Number(url.port))) {
    return Promise.reject(new Error("Forbidden probe port"));
  }
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

function createResponseDecoder(encoding: SupportedCoding): Transform {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
  }
}
