import { Agent, type IncomingMessage, request } from "node:http";
import { createConnection, isIP } from "node:net";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** One short, bounded request to the already verified literal container endpoint. No DNS or proxy. */
export async function directWebTransport(target: URL, init: RequestInit): Promise<Response> {
  const address = target.hostname.replace(/^\[|\]$/gu, "");
  if (target.protocol !== "http:" || !isIP(address) || target.username || target.password)
    throw new Error("Invalid published Web endpoint.");
  const port = Number(target.port || 80);
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => createConnection({ host: address, port });
  // Decoding untrusted bodies would run on the controller thread, so ask for them unencoded.
  const headers = {
    ...Object.fromEntries(new Headers(init.headers).entries()),
    "accept-encoding": "identity",
  };
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error, result?: Response) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      agent.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const outgoing = request(
      target,
      { agent, method: init.method, headers, signal: init.signal ?? undefined },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            incoming.destroy();
            finish(new Error("Published Web response limit exceeded."));
          } else chunks.push(chunk);
        });
        incoming.once("error", () => finish(new Error("Published Web response failed.")));
        incoming.once("end", () => {
          try {
            finish(undefined, webResponse(incoming, chunks, init.method));
          } catch {
            finish(new Error("Invalid published Web response."));
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      outgoing.destroy();
      finish(new Error("Published Web deadline exceeded."));
    }, 5000);
    outgoing.once("error", () => finish(new Error("Published Web connection failed.")));
    if (init.body instanceof ArrayBuffer) outgoing.end(Buffer.from(init.body));
    else if (init.body === undefined || init.body === null) outgoing.end();
    else {
      outgoing.destroy();
      finish(new Error("Unsupported published Web request body."));
    }
  });
}

function webResponse(incoming: IncomingMessage, chunks: Buffer[], method?: string): Response {
  const responseHeaders = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const key = incoming.rawHeaders[index],
      value = incoming.rawHeaders[index + 1];
    if (key !== undefined && value !== undefined) responseHeaders.append(key, value);
  }
  const status = incoming.statusCode ?? 502;
  const encoding = responseHeaders.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity")
    throw new Error("Published Web services must answer uncompressed responses.");
  const payload =
    [204, 205, 304].includes(status) || method === "HEAD" ? null : Buffer.concat(chunks);
  return new Response(payload, { status, headers: responseHeaders });
}
