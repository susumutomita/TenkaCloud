import type { IncomingMessage, ServerResponse } from "node:http";
import { createHttpServer } from "../lib/node-http";
import { proxyApplication } from "./application-proxy";
import { randomToken } from "./auth";
import type { ConsoleAppliance } from "./console-appliance";
import { directWebTransport } from "./direct-web-transport";
import { closeServer, errorResponse, listen } from "./http";
import { HostError, type Job } from "./model";
import type { HostingService } from "./service";
import { digest } from "./store";

interface Selection {
  teamId: string;
  problemId: string;
  serviceId: string;
}
interface Grant {
  teamId: string;
  keyHash: string;
  ownProblemId: string;
  target: Selection;
  origin: string;
  requester: string;
  publisher: string;
  upstream: string;
  expiresAt: number;
  epoch: number;
}
const fingerprint = (job: Job) =>
  digest(JSON.stringify([job.unit, job.definition, job.deployedAt]));
const cookieName = "__Host-tc_public";

/** Authentication remains in the console; untrusted HTML is served on a per-target origin. */
export class PublishedWebBroker {
  private readonly tickets = new Map<string, Grant>();
  private readonly sessions = new Map<string, Grant>();
  private active = 0;
  private readonly teamRequests = new Map<string, number>();
  private readonly epochs = new Map<string, number>();
  private readonly pending = new Set<string>();
  private readonly server = createHttpServer(
    async (request, response) => {
      if (++this.active > 64) {
        this.active--;
        throw new HostError(429, "Web broker is busy.");
      }
      try {
        await this.handle(request, response);
      } finally {
        this.active--;
      }
    },
    (response, error) => errorResponse(response, error),
  );
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!request.url?.startsWith("/") || request.url.startsWith("//"))
      throw new HostError(400, "Invalid challenge request target.");
    this.prune();
    const url = new URL(request.url, "https://broker.invalid");
    if (url.pathname === "/__join") {
      await this.join(request, response, url);
      return;
    }
    const grant = this.session(request);
    const active = this.teamRequests.get(grant.teamId) ?? 0;
    if (active >= 16) throw new HostError(429, "Too many Web requests for this team.");
    this.teamRequests.set(grant.teamId, active + 1);
    try {
      await proxyApplication({
        request,
        response,
        upstream: new URL(grant.upstream),
        origin: grant.origin,
        deniedPaths: ["/__join"],
        keyHash: grant.keyHash,
        forwardAuthorization: false,
        transport: directWebTransport,
        authorize: () => this.authorize(grant),
      });
    } finally {
      const remaining = (this.teamRequests.get(grant.teamId) ?? 0) - 1;
      if (remaining > 0) this.teamRequests.set(grant.teamId, remaining);
      else this.teamRequests.delete(grant.teamId);
    }
  }
  private async join(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== "GET" || [...url.searchParams.keys()].join(",") !== "ticket")
      throw new HostError(400, "Invalid Web handoff.");
    const key = digest(url.searchParams.get("ticket") ?? "");
    const grant = this.tickets.get(key);
    this.tickets.delete(key);
    if (!grant || request.headers.host !== new URL(grant.origin).host)
      throw new HostError(401, "Invalid or expired Web ticket.");
    await this.authorize(grant);
    if (
      this.sessions.size >= 1024 ||
      [...this.sessions.values()].filter((entry) => entry.teamId === grant.teamId).length >= 32
    )
      throw new HostError(429, "Too many Web sessions.");
    const token = randomToken();
    this.sessions.set(digest(token), {
      ...grant,
      expiresAt: this.service.now() + 15 * 60_000,
    });
    response.writeHead(303, {
      location: "/",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": `${cookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`,
    });
    response.end();
  }
  private session(request: IncomingMessage): Grant {
    const cookies = (request.headers.cookie ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${cookieName}=`));
    const grant =
      cookies.length === 1
        ? this.sessions.get(digest((cookies[0] ?? "").slice(cookieName.length + 1)))
        : undefined;
    if (!grant || request.headers.host !== new URL(grant.origin).host)
      throw new HostError(401, "Open this Web service from the console.");
    if (request.headers.origin && request.headers.origin !== grant.origin)
      throw new HostError(403, "Cross-origin challenge request denied.");
    if (
      request.headers["sec-fetch-site"] === "cross-site" &&
      !(request.method === "GET" && request.headers["sec-fetch-mode"] === "navigate")
    )
      throw new HostError(403, "Cross-site challenge request denied.");
    return grant;
  }

  constructor(
    private readonly service: HostingService,
    private readonly settings: ConsoleAppliance,
  ) {
    this.server.on("connect", (_request, socket) => socket.destroy());
    this.server.on("upgrade", (_request, socket) => socket.destroy());
  }
  listen(): Promise<string> {
    return listen(this.server, "127.0.0.1", this.settings.webPort);
  }
  async close(): Promise<void> {
    this.tickets.clear();
    this.sessions.clear();
    await closeServer(this.server);
  }
  async issue(
    teamId: string,
    keyHash: string,
    ownProblemId: string,
    target: Selection,
  ): Promise<string> {
    if (!this.settings.webServiceIds.includes(target.serviceId))
      throw new HostError(404, "This service is not configured as public Web.");
    this.prune();
    if (
      this.tickets.size >= 1024 ||
      [...this.tickets.values()].filter((grant) => grant.teamId === teamId).length >= 16
    )
      throw new HostError(429, "Too many Web tickets.");
    if (this.pending.has(teamId) || this.pending.size >= 32)
      throw new HostError(429, "Web handoff is busy.");
    this.pending.add(teamId);
    const epoch = this.epochs.get(teamId) ?? 0;
    try {
      const current = await this.service.authorizePublicWeb(teamId, keyHash, ownProblemId, target);
      const host = current.address.includes(":") ? `[${current.address}]` : current.address;
      const origin = new URL(
        this.settings.webOriginTemplate.replace(
          "{target}",
          digest(`${current.job.jobId}/${target.serviceId}`).slice(0, 32),
        ),
      ).origin;
      const grant: Grant = {
        teamId,
        epoch,
        keyHash,
        ownProblemId,
        target: { ...target },
        origin,
        requester: fingerprint(current.requester),
        publisher: fingerprint(current.job),
        upstream: `http://${host}:${current.port}`,
        expiresAt: this.service.now() + 30_000,
      };
      if (
        this.tickets.size >= 1024 ||
        [...this.tickets.values()].filter((entry) => entry.teamId === teamId).length >= 16
      )
        throw new HostError(429, "Too many Web tickets.");
      if ((this.epochs.get(teamId) ?? 0) !== epoch)
        throw new HostError(401, "Web access was revoked.");
      const ticket = randomToken();
      this.tickets.set(digest(ticket), grant);
      return `${origin}/__join?ticket=${encodeURIComponent(ticket)}`;
    } finally {
      this.pending.delete(teamId);
    }
  }
  private async authorize(grant: Grant): Promise<Job> {
    if (
      grant.epoch !== (this.epochs.get(grant.teamId) ?? 0) ||
      grant.expiresAt <= this.service.now()
    )
      throw new HostError(401, "Web access expired.");
    const current = await this.service.authorizePublicWeb(
      grant.teamId,
      grant.keyHash,
      grant.ownProblemId,
      grant.target,
    );
    if (
      grant.epoch !== (this.epochs.get(grant.teamId) ?? 0) ||
      grant.expiresAt <= this.service.now()
    )
      throw new HostError(401, "Web access expired.");
    const host = current.address.includes(":") ? `[${current.address}]` : current.address;
    if (
      fingerprint(current.requester) !== grant.requester ||
      fingerprint(current.job) !== grant.publisher ||
      `http://${host}:${current.port}` !== grant.upstream
    )
      throw new HostError(409, "Published Web environment changed.");
    return current.job;
  }
  revokeTeam(teamId: string): void {
    this.epochs.set(teamId, (this.epochs.get(teamId) ?? 0) + 1);
    for (const map of [this.tickets, this.sessions])
      for (const [key, grant] of map)
        if (grant.teamId === teamId) {
          grant.expiresAt = 0;
          map.delete(key);
        }
  }
  private prune(): void {
    for (const map of [this.tickets, this.sessions])
      for (const [key, grant] of map) if (grant.expiresAt <= this.service.now()) map.delete(key);
  }
}
