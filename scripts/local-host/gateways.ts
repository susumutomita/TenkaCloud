import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { secret } from "./auth";
import { closeServer, errorResponse, listen, readBody } from "./http";
import { HostError, type Job, type Team } from "./model";
import type { HostingService } from "./service";
import { digest } from "./store";

interface Grant { keyHash: string; expires: number }

interface Gateway { link(team: Team): string; close(): Promise<void> }
/** The intentionally vulnerable exercise MUST NOT share the portal/admin origin.
 * This initial, reviewed surface contract supports sqli-demo's three routes only.
 * Cookies/Authorization/Set-Cookie are never forwarded across the proxy boundary. */
export class SurfaceGateways {
  private readonly gateways = new Map<string, Promise<Gateway>>();
  constructor(private readonly hostname: string, private readonly service: HostingService) { }
  async link(job: Job, team: Team): Promise<string> {
    let gateway = this.gateways.get(job.jobId);
    if (!gateway) {
      gateway = this.create(job);
      this.gateways.set(job.jobId, gateway);
      void gateway.catch(() => this.gateways.delete(job.jobId));
    }
    return (await gateway).link(team);
  }
  async closeJob(jobId: string): Promise<void> {
    const gateway = this.gateways.get(jobId);
    if (!gateway) return;
    this.gateways.delete(jobId);
    await (await gateway).close();
  }
  async close(): Promise<void> {
    await Promise.all([...this.gateways.keys()].map(jobId => this.closeJob(jobId)));
  }
  private async create(job: Job): Promise<Gateway> {
    const upstream = new URL(this.service.engine.surface(job));
    if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || upstream.username || upstream.password) throw new Error("Challenge surface must be an explicit loopback HTTP endpoint.");
    let origin = "";
    const pending = new Map<string, Grant>();
    const sessions = new Map<string, Grant>();
    const cookieName = `tc_exercise_${job.jobId.toLowerCase()}`;
    const server = createServer((request, response) => {
      void handle(request, response).catch(error => errorResponse(response, error));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.setTimeout(15_000, socket => socket.destroy());
    const service = this.service;
    function expire(): void {
      const now = service.now();
      for (const [key, grant] of sessions) if (grant.expires <= now) sessions.delete(key);
      for (const [ticket, grant] of pending) if (grant.expires <= now) pending.delete(ticket);
    }
    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      if (request.headers.host !== new URL(origin).host) throw new HostError(403, "Untrusted challenge Host header.");
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) throw new HostError(403, "Invalid challenge request target.");
      expire();
      if (request.method === "GET" && url.pathname === "/__join") {
        const ticket = url.searchParams.get("ticket") ?? "";
        const grant = pending.get(ticket);
        if (!grant) throw new HostError(401, "Challenge link expired or already used. Open it again from the participant portal.");
        pending.delete(ticket);
        service.authorizeSurface(job.jobId, grant.keyHash);
        if (sessions.size >= 256) throw new HostError(429, "Too many challenge browser sessions.");
        const token = secret();
        sessions.set(digest(token), { keyHash: grant.keyHash, expires: service.now() + 60 * 60_000 });
        response.writeHead(
          303,
          {
            location: "/",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "set-cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`
          }
        );
        response.end();
        return;
      }
      const cookies = (request.headers.cookie ?? "").split(";").map(part => part.trim());
      const token = cookies.find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? "";
      const grant = sessions.get(digest(token));
      if (!grant) throw new HostError(401, "Open this environment from your team's participant portal.");
      service.authorizeSurface(job.jobId, grant.keyHash);
      if (request.headers.origin && request.headers.origin !== origin) throw new HostError(403, "Cross-origin challenge requests are forbidden.");
      const method = request.method ?? "GET";
      const allowed = (method === "GET" && ["/", "/healthz"].includes(url.pathname)) || (method === "POST" && url.pathname === "/login");
      if (!allowed) throw new HostError(404, "Challenge route not exposed.");
      if (method === "POST" && request.headers.origin !== origin) throw new HostError(403, "A same-origin form submission is required.");
      const body = method === "POST" ? await readBody(request) : undefined;
      const target = new URL(url.pathname, upstream.origin);
      const type = request.headers["content-type"] ?? "application/x-www-form-urlencoded";
      if (method === "POST" && !/^(application\/json|application\/x-www-form-urlencoded)(?:;|$)/iu.test(type)) throw new HostError(415, "Unsupported challenge input.");
      const result = await fetch(
        target,
        {
          method,
          body,
          headers: { "content-type": type, accept: "text/html,application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(5000)
        }
      );
      if (!result.body) throw new HostError(502, "Challenge returned no response body.");
      const reader = result.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (; ;) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.length;
          if (total > 2 * 1024 * 1024) throw new HostError(502, "Challenge response exceeded its limit.");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      const responseType = result.headers.get("content-type") ?? "application/octet-stream";
      if (!/^(text\/html|application\/json)(?:;|$)/iu.test(responseType)) throw new HostError(502, "Unsupported challenge response type.");
      response.writeHead(
        result.status,
        {
          "content-type": responseType,
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer"
        }
      );
      response.end(Buffer.concat(chunks));
    }
    origin = await listen(server, this.hostname, 0);
    return {
      link: team => {
        expire();
        const keyHash = digest(team.loginKey);
        service.authorizeSurface(job.jobId, keyHash);
        if (pending.size >= 256) throw new HostError(429, "Too many pending challenge handoffs; retry in one minute.");
        const ticket = secret();
        pending.set(ticket, { keyHash, expires: service.now() + 60_000 });
        return `${origin}/__join?ticket=${ticket}`;
      },
      close: () => closeServer(server),
    };
  }
}
