import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomToken } from "./auth";
import { closeServer, errorResponse, listen, readBody } from "./http";
import { HostError, type Job, type Team } from "./model";
import type { HostingService } from "./service";
import { digest } from "./store";

interface Grant {
  keyHash: string;
  expires: number;
}

interface Gateway {
  link(team: Team): string;
  close(): Promise<void>;
}

interface Route {
  method: "GET" | "POST";
  path: "/" | "/healthz" | "/login";
}

/** The only upstream requests a gateway issues: sqli-demo's three reviewed routes. The
 * proxied path is always taken from this table, never from the participant's request URL. */
const ROUTES: readonly Route[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/healthz" },
  { method: "POST", path: "/login" },
];
const SESSION_LIMIT = 256;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const inputTypes = /^(application\/json|application\/x-www-form-urlencoded)(?:;|$)/iu;
const outputTypes = /^(text\/html|application\/json)(?:;|$)/iu;

async function collectUpstream(result: Response): Promise<Buffer> {
  if (!result.body) throw new HostError(502, "Challenge returned no response body.");
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > MAX_UPSTREAM_BYTES)
        throw new HostError(502, "Challenge response exceeded its limit.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

/** One loopback/LAN listener per deployed job, on its own origin. Browser sessions are
 * created only through one-use tickets issued from an authenticated team view. */
class JobGateway implements Gateway {
  private origin = "";
  private readonly pending = new Map<string, Grant>();
  private readonly sessions = new Map<string, Grant>();
  private readonly cookieName: string;
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch((error) => errorResponse(response, error));
  });
  constructor(
    private readonly job: Job,
    private readonly upstream: URL,
    private readonly service: HostingService,
  ) {
    this.cookieName = `tc_exercise_${job.jobId.toLowerCase()}`;
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.server.setTimeout(15_000, (socket) => socket.destroy());
  }
  async listen(hostname: string): Promise<void> {
    this.origin = await listen(this.server, hostname, 0);
  }
  close(): Promise<void> {
    return closeServer(this.server);
  }
  link(team: Team): string {
    this.expire();
    const keyHash = digest(team.loginKey);
    this.service.authorizeSurface(this.job.jobId, keyHash);
    if (this.pending.size >= SESSION_LIMIT)
      throw new HostError(429, "Too many pending challenge handoffs; retry in one minute.");
    const ticket = randomToken();
    this.pending.set(ticket, { keyHash, expires: this.service.now() + 60_000 });
    return `${this.origin}/__join?ticket=${ticket}`;
  }
  private expire(): void {
    const now = this.service.now();
    for (const [key, grant] of this.sessions) if (grant.expires <= now) this.sessions.delete(key);
    for (const [ticket, grant] of this.pending)
      if (grant.expires <= now) this.pending.delete(ticket);
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== new URL(this.origin).host)
      throw new HostError(403, "Untrusted challenge Host header.");
    const url = new URL(request.url ?? "/", this.origin);
    if (url.origin !== this.origin) throw new HostError(403, "Invalid challenge request target.");
    this.expire();
    if (request.method === "GET" && url.pathname === "/__join") {
      this.join(url.searchParams.get("ticket") ?? "", response);
      return;
    }
    this.authenticate(request);
    const route = ROUTES.find(
      (candidate) => candidate.method === request.method && candidate.path === url.pathname,
    );
    if (!route) throw new HostError(404, "Challenge route not exposed.");
    await this.proxy(request, response, route);
  }
  private join(ticket: string, response: ServerResponse): void {
    const grant = this.pending.get(ticket);
    if (!grant)
      throw new HostError(
        401,
        "Challenge link expired or already used. Open it again from the participant portal.",
      );
    this.pending.delete(ticket);
    this.service.authorizeSurface(this.job.jobId, grant.keyHash);
    if (this.sessions.size >= SESSION_LIMIT)
      throw new HostError(429, "Too many challenge browser sessions.");
    // A random session identifier; the team key never reaches the exercise origin.
    const token = randomToken();
    this.sessions.set(digest(token), {
      keyHash: grant.keyHash,
      expires: this.service.now() + 60 * 60_000,
    });
    response.writeHead(303, {
      location: "/",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
    });
    response.end();
  }
  private authenticate(request: IncomingMessage): void {
    const prefix = `${this.cookieName}=`;
    const token =
      (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix))
        ?.slice(prefix.length) ?? "";
    const grant = this.sessions.get(digest(token));
    if (!grant)
      throw new HostError(401, "Open this environment from your team's participant portal.");
    this.service.authorizeSurface(this.job.jobId, grant.keyHash);
    if (request.headers.origin && request.headers.origin !== this.origin)
      throw new HostError(403, "Cross-origin challenge requests are forbidden.");
  }
  private async proxy(
    request: IncomingMessage,
    response: ServerResponse,
    route: Route,
  ): Promise<void> {
    const type = request.headers["content-type"] ?? "application/x-www-form-urlencoded";
    let body: string | undefined;
    if (route.method === "POST") {
      if (request.headers.origin !== this.origin)
        throw new HostError(403, "A same-origin form submission is required.");
      if (!inputTypes.test(type)) throw new HostError(415, "Unsupported challenge input.");
      body = await readBody(request);
    }
    const result = await fetch(new URL(route.path, this.upstream.origin), {
      method: route.method,
      body,
      headers: { "content-type": type, accept: "text/html,application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const responseType = result.headers.get("content-type") ?? "application/octet-stream";
    if (!outputTypes.test(responseType))
      throw new HostError(502, "Unsupported challenge response type.");
    const payload = await collectUpstream(result);
    response.writeHead(result.status, {
      "content-type": responseType,
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      // Not `no-referrer`: browsers derive the Origin header of a form POST navigation from the
      // document's referrer policy, and `no-referrer` makes the exercise's own login form arrive
      // with `Origin: null`, which the same-origin check above rightly refuses. `same-origin`
      // still sends nothing to any other origin.
      "referrer-policy": "same-origin",
    });
    response.end(payload);
  }
}

/** The intentionally vulnerable exercise MUST NOT share the portal/admin origin.
 * Cookies/Authorization/Set-Cookie are never forwarded across the proxy boundary. */
export class SurfaceGateways {
  private readonly gateways = new Map<string, Promise<Gateway>>();
  constructor(
    private readonly hostname: string,
    private readonly service: HostingService,
  ) {}
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
    await Promise.all([...this.gateways.keys()].map((jobId) => this.closeJob(jobId)));
  }
  private async create(job: Job): Promise<Gateway> {
    const upstream = new URL(this.service.engine.surface(job));
    if (
      upstream.protocol !== "http:" ||
      upstream.hostname !== "127.0.0.1" ||
      upstream.username ||
      upstream.password
    )
      throw new Error("Challenge surface must be an explicit loopback HTTP endpoint.");
    const gateway = new JobGateway(job, upstream, this.service);
    await gateway.listen(this.hostname);
    return gateway;
  }
}
