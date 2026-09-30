import { randomUUID } from "node:crypto";
import type { ProbeFn } from "../../infrastructure/lib/problem-deploy/runtime-clients/http-probe-client";
import { HostAuditLog } from "./audit-log";
import { type AuditOperation, auditActor } from "./audit-record";
import { auditFailure, auditRequest } from "./audit-request";
import { id, issueOrganizerSession, randomToken, SerialQueue, sameSecret } from "./auth";
import { LocalCoordination } from "./coordination";
import { LocalDisruptions } from "./disruptions";
import {
  formatGatewayPorts,
  type GatewayPortRange,
  gatewayPort,
  gatewaySlots,
  MAX_JOBS,
  SLOT_STRIDE,
} from "./gateway-ports";
import {
  type AccountConnection,
  type AwsTarget,
  assertPlaying,
  type CompetitorAccount,
  type Context,
  definitionKind,
  type Gate,
  gate,
  HostError,
  type HostedEvent,
  hasStarted,
  isSolve,
  type Job,
  type JobOperation,
  object,
  type Problem,
  type RuntimeEngine,
  scoringEnded,
  type Team,
  text,
} from "./model";
import { type OrganizerPermission, requireOrganizerPermission } from "./organizer-access";
import { ParticipantAssumeRoleError, type ParticipantAwsAccess } from "./participant-aws-access";
import { portsFree } from "./ports";
import { HostProgression, lockedProblem } from "./progression";
import { HostRegistration } from "./registration";
import { SamlSignIn } from "./saml-sign-in";
import { projectedScore, projectedTimeline } from "./score";
import {
  digest,
  type HostStore,
  type OrganizerPrincipal,
  type OrganizerRole,
  type OrganizerStatus,
  type OrganizerUser,
  type OrganizerView,
} from "./store";
import { LocalUptime, uptimeGeneration } from "./uptime";

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  token: string;
  nonce?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  contentType?: "text/csv; charset=utf-8";
}
const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
const eventPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const awsAccountPattern = /^\d{12}$/u;
const awsRoleNamePattern = /^[A-Za-z0-9_+=,.@-]{1,64}$/u;
/** Existing bootstrap default; the form may propose a host-scoped name explicitly. */
const DEFAULT_COMPETITOR_ROLE = "TenkaCloud-CompetitorDeploy-Role";
const SLOT_QUEUE = "runtime-slots";
const NONTERMINAL_STATUSES: readonly Job["status"][] = ["PENDING", "IN_PROGRESS"];
/** Organizer-intended states of one environment that do not make a ready event undeployed. */
const INTENDED_IDLE_STATUSES: readonly Job["status"][] = ["STOPPED", "DELETED"];
const jobPattern = eventPattern;
const usernamePattern = /^[a-z][a-z0-9._-]{2,63}$/u;

function adminPath(path: string): string {
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HostError(400, "Invalid host endpoint.");
  }
  if (parts.some((part) => part.includes("/"))) throw new HostError(400, "Invalid host endpoint.");
  return `/${parts.join("/")}`;
}

function username(value: unknown): string {
  if (typeof value !== "string" || !usernamePattern.test(value))
    throw new HostError(
      400,
      "Username must be 3–64 lowercase letters, digits, dots, underscores, or hyphens.",
    );
  return value;
}
function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 256)
    throw new HostError(400, "Password must be 12–256 characters.");
  return value;
}
function organizerRole(value: unknown): OrganizerRole {
  if (
    typeof value === "string" &&
    (value === "Admin" || value === "Operator" || value === "Viewer")
  )
    return value;
  throw new HostError(400, "Invalid organizer role.");
}
function organizerStatus(value: unknown): OrganizerStatus {
  if (value === "active" || value === "disabled") return value;
  throw new HostError(400, "Invalid organizer status.");
}
function requireRole(principal: OrganizerPrincipal, permission: OrganizerPermission): void {
  requireOrganizerPermission(principal.role, permission);
}
function requireAdmin(principal: OrganizerPrincipal): void {
  requireRole(principal, "manage-connections");
  if (!principal.userId) throw new HostError(403, "Complete organizer bootstrap first.");
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 2000) : fallback;
}

const NOTICE_JA =
  "> 競技モードでは、問題環境の起動・停止は主催者が行います。問題文の「起動」操作は不要です。競技中は「アクセス先 URL」の Web を開いてください。\n\n";
const NOTICE_EN =
  "> In competition mode, the organizer starts and stops your environment. Skip the problem's Start instruction and open Web under Access URLs during the event.\n\n";

type Runtime = NonNullable<Problem["runtime"]>;

/** What the portal names as each runtime's provider. */
const PROVIDERS: Record<Runtime, string> = {
  docker: "docker",
  coordination: "local",
  cloudformation: "aws",
};

function withEnglish(
  problem: Record<string, unknown>,
  edit: (english: Record<string, unknown>) => void,
): void {
  if (!problem.i18n) return;
  const english = { ...object(object(problem.i18n).en) };
  edit(english);
  problem.i18n = { en: english };
}

/** Strip organizer-only and not-yet-earned content from a scorer problem view. */
function participantProblem(
  raw: Record<string, unknown>,
  runtime: Runtime,
  gateKind: Gate["kind"],
  ended: boolean,
): Record<string, unknown> {
  const problem = { ...raw };
  delete problem.lifecycle; // Competition environments are host-owned, never participant-resettable.
  delete problem.recommended;
  // The notice points at the Docker exercise's Web link; other runtimes have none.
  if (runtime === "docker" && typeof problem.instructions === "string")
    problem.instructions = NOTICE_JA + problem.instructions;
  withEnglish(problem, (english) => {
    if (runtime === "docker" && typeof english.instructions === "string")
      english.instructions = NOTICE_EN + english.instructions;
  });
  if (!ended) {
    delete problem.writeup;
    withEnglish(problem, (english) => {
      delete english.writeup;
    });
  }
  if (gateKind === "scoring_not_started") {
    problem.instructions = "";
    delete problem.i18n;
  }
  return problem;
}

function showUptimeStatus(
  store: HostStore,
  context: Context,
  problem: Record<string, unknown>,
  job: Job | undefined,
): void {
  if (!problem.scoring || object(problem.scoring).kind !== "uptime-flat") return;
  const state = store.uptimeState(
    context.event.eventId,
    context.team.teamId,
    String(problem.problemId),
  );
  const current = job?.status === "COMPLETE" && state.generation === uptimeGeneration(job);
  const health =
    current && state.endpointsHealth
      ? (JSON.parse(state.endpointsHealth) as Record<string, { ok: boolean; checkedAt: string }>)
      : {};
  const observations = Object.values(health);
  const healthyCount = observations.filter((entry) => entry.ok).length;
  const totalCount = observations.length;
  let overall = "unknown";
  if (totalCount > 0) {
    if (healthyCount === totalCount) overall = "healthy";
    else if (healthyCount === 0) overall = "down";
    else overall = "degraded";
  }
  problem.applicationStatus = {
    overall,
    healthyCount,
    totalCount,
    ...(observations[0]?.checkedAt ? { checkedAt: observations[0].checkedAt } : {}),
  };
  if (current && state.lastResult) problem.lastResult = state.lastResult;
  if (job?.deployedAt) problem.createdAt = new Date(job.deployedAt).toISOString();
}

/** The local adapter retains the existing admin/participant HTTP contracts. */
export class HostingService {
  readonly saml: SamlSignIn;
  readonly audit: HostAuditLog;
  private readonly queue = new SerialQueue();
  readonly registration: HostRegistration;
  private readonly coordination = new LocalCoordination(this);
  readonly progression: HostProgression;
  readonly disruptions: LocalDisruptions;
  private readonly tasks = new Set<Promise<void>>();
  private readonly busyEvents = new Set<string>();
  /** jobId → eventId of single-environment operations still running. */
  private readonly busyJobs = new Map<string, string>();
  readonly uptime: LocalUptime;
  surfaceLink?: (job: Job, team: Team) => Promise<string>;
  closeSurface?: (jobId: string) => Promise<void>;
  /** Fixed exercise-gateway ports; a runtime slot is only used when its gateway port is free. */
  gatewayPorts?: GatewayPortRange;
  /** The address the gateways listen on (loopback, or the `--lan` address). */
  gatewayHostname = "127.0.0.1";
  accountConnection?: AccountConnection;
  constructor(
    readonly store: HostStore,
    readonly engine: RuntimeEngine,
    private readonly masterKey: string,
    readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = console.error,
    uptimeProbe?: ProbeFn,
  ) {
    this.progression = new HostProgression(store, now);
    this.saml = new SamlSignIn(store, masterKey, now);
    this.audit = new HostAuditLog(store, now);
    this.disruptions = new LocalDisruptions(this);
    this.uptime = new LocalUptime(
      store,
      now,
      (eventId, action) => this.queue.run(eventId, action),
      () => ({ progression: this.progression, disruptions: this.disruptions }),
      uptimeProbe,
      log,
    );
    this.registration = new HostRegistration(store, now);
    this.registration.onMutation = (mutation) => {
      if (mutation.action !== "claim_registration" || !mutation.teamId) return;
      this.audit.append({
        operationId: randomUUID(),
        phase: "request",
        actor: { kind: "anonymous" },
        action: "registration.claimed",
        resource: { kind: "team", id: mutation.teamId },
        outcome: "succeeded",
      });
    };
  }
  private currentEvent(eventId: string): HostedEvent {
    const event = this.store.event(eventId);
    if (event.status === "READY" && event.endsAt && Date.parse(event.endsAt) <= this.now()) {
      event.status = "ENDED";
      event.updatedAt = new Date(this.now()).toISOString();
      this.store.putEvent(event);
    }
    return event;
  }
  private summary(event: HostedEvent) {
    const { problems, ...summary } = event;
    return {
      ...summary,
      ...(!this.progression.configurationValid(event)
        ? { progressionGate: undefined, progressionGateError: "invalid_progression_gate" }
        : {}),
      teamCount: this.store.teams(event.eventId).length,
      problemCount: problems.length,
    };
  }
  private detail(event: HostedEvent, query: URLSearchParams) {
    const teams = this.store.teams(event.eventId);
    const jobs = this.store.jobs(event.eventId);
    return {
      ...this.summary(event),
      teams: teams.map((team) => ({
        teamId: team.teamId,
        internalSlug: team.internalSlug,
        displayName: team.displayName,
        ...(query.get("withTeamLoginKeys") === "true" ? { teamLoginKey: team.loginKey } : {}),
      })),
      problems: event.problems.map((problem) => ({
        problemId: problem.problemId,
        defaultRegion: "local",
      })),
      deploymentsByProblem: Object.fromEntries(
        event.problems.map((problem) => [
          problem.problemId,
          jobs
            .filter((job) => job.problemId === problem.problemId)
            .map((job) => ({
              jobId: job.jobId,
              teamId: job.teamId,
              status: job.status,
              stopSupported: definitionKind(job.definition) !== "cloudformation",
              ...(job.error ? { error: job.error } : {}),
              ...(job.operation ? { operation: job.operation } : {}),
              ...this.gatewayPortField(job),
            })),
        ]),
      ),
      ...(query.get("withScoreEvents") === "true"
        ? {
            scoreEventsByTeam: teams.map((team) => {
              const events = [...team.scoreEvents].reverse();
              const timeline = projectedTimeline(event, events);
              const projected = projectedScore(event, events);
              return {
                teamId: team.teamId,
                teamName: team.displayName,
                projectedTotal: projected.total,
                projectedByProblem: projected.byProblem,
                events: events.map((entry, index) => ({
                  ...entry,
                  projectedTotal: timeline[index],
                })),
              };
            }),
          }
        : {}),
    };
  }
  /** Display-only: an out-of-range slot is reported by the gateway itself when it is opened. */
  private gatewayPortField(job: Job): { gatewayPort?: number } {
    const range = this.gatewayPorts;
    if (!range || job.status === "DELETED" || !this.needsGateway(job.definition)) return {};
    const slot = job.offset / SLOT_STRIDE;
    return Number.isInteger(slot) && slot >= 1 && slot <= gatewaySlots(range)
      ? { gatewayPort: gatewayPort(range, job.offset) }
      : {};
  }
  async admin(input: ApiRequest): Promise<ApiResponse> {
    const request = { ...input, path: adminPath(input.path) };
    const operation = auditRequest(request.method, request.path);
    try {
      return await this.adminRequest(request, operation);
    } catch (error) {
      if (operation) this.audit.observe({ ...operation, phase: "request", ...auditFailure(error) });
      throw error;
    }
  }
  private async adminRequest(
    request: ApiRequest,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse> {
    const unauthenticated = await this.adminLogin(request, operation);
    if (unauthenticated) return unauthenticated;
    const publicSaml = await this.publicSamlRoute(request, operation);
    if (publicSaml) return publicSaml;
    const principal = this.store.authenticateAdmin(request.token, this.now());
    if (operation) operation.actor = auditActor(principal);
    const auditResponse = this.auditRoute(request, principal);
    if (auditResponse) return auditResponse;
    const samlResponse = this.samlAdminRoute(request, principal, operation);
    if (samlResponse) return samlResponse;
    const fixed = await this.adminFixedRoute(request, principal, operation);
    if (fixed) return fixed;
    const parts = request.path.split("/").filter(Boolean);
    const eventId = parts[0] === "events" ? parts[1] : undefined;
    if (!eventId || !eventPattern.test(eventId)) throw new HostError(404, "Unknown host endpoint.");
    if (parts.length === 3 && parts[2] === "registration" && request.method === "GET")
      return this.queue.run(eventId, async () => {
        const current = this.store.authenticateAdmin(request.token, this.now());
        return ok(this.registration.summary(eventId, current.role === "Admin"));
      });
    if (parts.length === 3 && parts[2] === "progression-gate" && request.method === "GET")
      return this.queue.run(eventId, async () => {
        this.store.authenticateAdmin(request.token, this.now());
        return ok({ progressionGate: this.currentEvent(eventId).progressionGate });
      });
    if (parts.length === 2 && request.method === "GET")
      return this.queue.run(eventId, async () => {
        const current = this.store.authenticateAdmin(request.token, this.now());
        requireRole(
          current,
          request.query.get("withTeamLoginKeys") === "true" ? "reveal-team-keys" : "read",
        );
        const event = this.currentEvent(eventId);
        this.coordination.advance(event);
        return ok(this.detail(event, request.query));
      });
    return this.queue.run(eventId, async () => {
      const current = this.store.authenticateAdmin(request.token, this.now());
      if (operation) operation.actor = auditActor(current);
      if (parts[2] === "registration") requireAdmin(current);
      let permission: OrganizerPermission = "run-events";
      if (parts[2] === "teams") permission = "reveal-team-keys";
      else if (parts[2] === "disruptions" && request.method === "GET") permission = "read";
      requireRole(current, permission);
      return this.mutateEvent(
        this.currentEvent(eventId),
        parts.slice(2),
        request,
        operation,
        current,
      );
    });
  }
  private async publicSamlRoute(
    request: ApiRequest,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse | undefined> {
    if (request.path === "/host/saml" && request.method === "GET")
      return ok({ enabled: this.saml.available() });
    if (request.path === "/host/saml/start" && request.method === "POST")
      return ok(await this.saml.start(request.body));
    if (request.path === "/host/saml/complete" && request.method === "POST")
      return this.completeSaml(request.body, operation);
    return undefined;
  }
  private completeSaml(input: unknown, operation: AuditOperation | undefined): ApiResponse {
    return this.store.transaction(() => {
      const session = this.saml.complete(input);
      if (operation)
        operation.actor = auditActor(this.store.authenticateAdmin(session.idToken, this.now()));
      return this.audit.commit(operation, () => ok(session));
    });
  }
  private auditRoute(request: ApiRequest, principal: OrganizerPrincipal): ApiResponse | undefined {
    if (
      request.method !== "GET" ||
      !["/admin/audit-log", "/admin/audit-log/export"].includes(request.path)
    )
      return undefined;
    requireAdmin(principal);
    if (request.path === "/admin/audit-log") return ok(this.audit.list(request.query));
    return {
      status: 200,
      body: this.audit.exportCsv(request.query),
      contentType: "text/csv; charset=utf-8",
    };
  }
  private samlAdminRoute(
    request: ApiRequest,
    principal: OrganizerPrincipal,
    operation: AuditOperation | undefined,
  ): ApiResponse | undefined {
    if (!request.path.startsWith("/host/saml/")) return undefined;
    requireAdmin(principal);
    if (request.path === "/host/saml/provider" && request.method === "GET")
      return ok(this.saml.settings());
    if (request.path === "/host/saml/provider" && request.method === "PUT") {
      this.audit.commit(operation, () => this.saml.configure(request.body));
      return ok(this.saml.settings());
    }
    if (request.path === "/host/saml/identities" && request.method === "POST") {
      this.store.transaction(() => {
        const identityId = this.saml.link(request.body);
        if (operation) operation.resource = { kind: "identity", id: identityId };
        this.audit.commit(operation, () => undefined);
      });
      return ok({ identities: this.saml.identities() }, 201);
    }
    const identity = /^\/host\/saml\/identities\/([^/]+)$/u.exec(request.path);
    if (identity?.[1] && request.method === "DELETE") {
      this.audit.commit(operation, () => this.saml.unlink(identity[1] ?? ""));
      return ok({ identities: this.saml.identities() });
    }
    return undefined;
  }
  private async adminLogin(
    request: ApiRequest,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse | undefined> {
    if (request.path === "/host/bootstrap-status" && request.method === "GET")
      return ok({ bootstrapCompleted: this.store.bootstrapCompleted() });
    if (request.path === "/host/bootstrap" && request.method === "POST")
      return this.bootstrapOrganizer(request.body, operation);
    if (request.path === "/host/login" && request.method === "POST")
      return this.loginOrganizer(request.body, operation);
    if (request.path === "/host/logout" && request.method === "POST") {
      // A revocation handle only revokes itself and works after its access token expires.
      const body = object(request.body);
      const principal = this.store.revokeSession(text(body.refreshToken, "refreshToken", 128));
      if (operation && principal)
        this.audit.observe({
          ...operation,
          actor: auditActor(principal),
          phase: "request",
          outcome: "succeeded",
        });
      return ok({ revoked: true });
    }
    return undefined;
  }
  private async bootstrapOrganizer(
    input: unknown,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse> {
    if (this.store.bootstrapCompleted()) throw new HostError(409, "Host bootstrap is complete.");
    const body = object(input);
    if (typeof body.key !== "string" || !sameSecret(this.masterKey, body.key))
      throw new HostError(401, "Invalid host key.");
    const name = username(body.username);
    const hash = await Bun.password.hash(password(body.password), { algorithm: "argon2id" });
    const user: OrganizerUser = {
      id: id(this.now()),
      username: name,
      role: "Admin",
      status: "active",
      authVersion: 1,
      passwordHash: hash,
      createdAt: this.now(),
    };
    if (operation) operation.resource = { kind: "organizer", id: user.id };
    return this.audit.commit(operation, () => {
      const identity = this.store.bootstrap(user);
      return ok(issueOrganizerSession(this.store, this.masterKey, user, this.now(), identity), 201);
    });
  }
  private async loginOrganizer(
    input: unknown,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse> {
    if (!this.store.bootstrapCompleted())
      throw new HostError(
        409,
        "Create the first Admin account before signing in.",
        "bootstrap_required",
      );
    const body = object(input);
    const name =
      typeof body.username === "string" && usernamePattern.test(body.username) ? body.username : "";
    const secret = typeof body.password === "string" ? body.password : "";
    const identity = this.store.identity("local-password", "local-host", name);
    const user = identity ? this.store.organizer(identity.userId) : undefined;
    if (
      !identity ||
      !user ||
      user.username !== name ||
      user.status !== "active" ||
      !(await Bun.password.verify(secret, user.passwordHash))
    )
      throw new HostError(401, "Invalid username or password.");
    // Argon2 verification yields. Recheck role, status, password, and identity before issue.
    return this.store.transaction(() => {
      const currentIdentity = this.store.identity("local-password", "local-host", name);
      const current = currentIdentity ? this.store.organizer(currentIdentity.userId) : undefined;
      if (
        !currentIdentity ||
        !current ||
        current.id !== user.id ||
        current.status !== "active" ||
        current.authVersion !== user.authVersion ||
        current.passwordHash !== user.passwordHash ||
        currentIdentity.id !== identity.id
      )
        throw new HostError(401, "Invalid username or password.");
      if (operation)
        operation.actor = {
          kind: "organizer",
          userId: current.id,
          role: current.role,
          authMethod: "local-password",
        };
      return this.audit.commit(operation, () =>
        ok(issueOrganizerSession(this.store, this.masterKey, current, this.now(), currentIdentity)),
      );
    });
  }
  private async adminFixedRoute(
    request: ApiRequest,
    principal: OrganizerPrincipal,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse | undefined> {
    if (request.path === "/host/me" && request.method === "GET")
      return ok({
        user: principal.userId
          ? this.publicOrganizer(this.store.organizer(principal.userId))
          : null,
        role: principal.role,
        authMethod: principal.authMethod,
      });
    const organizer = await this.organizerRoutes(request, principal, operation);
    if (organizer) return organizer;
    if (request.path.startsWith("/admin/competitor-accounts"))
      return this.accountRoute(request, principal, operation);
    if (request.path === "/host/catalog" && request.method === "GET") {
      return ok({
        items: this.engine.catalog().map((problem) => ({
          problemId: problem.problemId,
          name: problem.name,
          runtime: problem.runtime ?? "docker",
        })),
      });
    }
    if (request.path === "/events" && request.method === "GET") {
      return ok({
        items: this.store.events().map((event) => this.summary(this.currentEvent(event.eventId))),
      });
    }
    if (request.path === "/events" && request.method === "POST") {
      requireRole(principal, "run-events");
      return this.createEvent(object(request.body), operation);
    }
    return undefined;
  }
  private async organizerRoutes(
    request: ApiRequest,
    principal: OrganizerPrincipal,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse | undefined> {
    if (request.path === "/host/users" && request.method === "GET") {
      requireAdmin(principal);
      return ok({ items: this.store.organizers() });
    }
    if (request.path === "/host/users" && request.method === "POST") {
      requireAdmin(principal);
      return this.createOrganizer(request, operation);
    }
    const userPath = /^\/host\/users\/([0-9A-HJKMNP-TV-Z]{26})$/u.exec(request.path);
    if (userPath) {
      requireAdmin(principal);
      const userId = userPath[1] ?? "";
      if (request.method === "DELETE") {
        this.audit.commit(operation, () => this.store.deleteOrganizer(userId));
        return ok({ deleted: true });
      }
      if (request.method === "PATCH") {
        return this.updateOrganizer(request, userId, operation);
      }
    }
    if (request.path === "/feature-flags" && request.method === "GET")
      return ok({ flags: this.store.featureFlags() });
    if (request.path === "/feature-flags" && request.method === "PUT") {
      requireAdmin(principal);
      return this.updateFeatureFlag(request.body, operation, principal);
    }
    return undefined;
  }
  private async createOrganizer(
    request: ApiRequest,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse> {
    const body = object(request.body);
    const name = username(body.username);
    const role = organizerRole(body.role);
    const hash = await Bun.password.hash(password(body.password), { algorithm: "argon2id" });
    return this.store.transaction(() => {
      requireAdmin(this.store.authenticateAdmin(request.token, this.now()));
      if (this.store.organizerByUsername(name))
        throw new HostError(409, "Username already exists.");
      const user: OrganizerUser = {
        id: id(this.now()),
        username: name,
        role,
        status: "active",
        authVersion: 1,
        passwordHash: hash,
        createdAt: this.now(),
      };
      if (operation) {
        operation.actor = auditActor(this.store.authenticateAdmin(request.token, this.now()));
        operation.resource = { kind: "organizer", id: user.id };
      }
      return this.audit.commit(operation, () => {
        this.store.insertOrganizer(user);
        return ok({ user: this.publicOrganizer(user) }, 201);
      });
    });
  }
  private async updateOrganizer(
    request: ApiRequest,
    userId: string,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse> {
    const body = object(request.body);
    const current = this.store.organizer(userId);
    if (!current) throw new HostError(404, "Organizer not found.");
    const hash =
      body.password === undefined
        ? current.passwordHash
        : await Bun.password.hash(password(body.password), { algorithm: "argon2id" });
    const updated: OrganizerUser = {
      ...current,
      role: body.role === undefined ? current.role : organizerRole(body.role),
      status: body.status === undefined ? current.status : organizerStatus(body.status),
      passwordHash: hash,
    };
    requireAdmin(this.store.authenticateAdmin(request.token, this.now()));
    if (operation)
      operation.actor = auditActor(this.store.authenticateAdmin(request.token, this.now()));
    return this.audit.commit(operation, () => {
      this.store.updateOrganizer(updated);
      return ok({ user: this.publicOrganizer(this.store.organizer(userId)) });
    });
  }
  private updateFeatureFlag(
    input: unknown,
    operation: AuditOperation | undefined,
    principal: OrganizerPrincipal,
  ): ApiResponse {
    const body = object(input);
    const key = body.key;
    if (
      key !== "saml" &&
      key !== "audit" &&
      key !== "challengePrerequisiteGate" &&
      key !== "registration"
    )
      throw new HostError(400, "Unknown feature flag.");
    if (typeof body.enabled !== "boolean")
      throw new HostError(400, "Flag enabled must be boolean.");
    const enabled = body.enabled;
    if (key === "audit") this.audit.setEnabled(enabled, auditActor(principal));
    else {
      if (operation) operation.resource = { kind: "feature", id: key };
      this.audit.commit(operation, () => {
        this.store.setFeatureFlag(key, enabled);
        if (key === "saml" && !enabled) this.saml.invalidate();
        if (key === "challengePrerequisiteGate" && enabled) this.progression.captureAllEvents();
      });
    }
    return ok({ flags: this.store.featureFlags() });
  }
  private publicOrganizer(user: OrganizerUser | undefined): OrganizerView {
    if (!user) throw new HostError(401, "Host session expired or invalid.");
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      authVersion: user.authVersion,
      createdAt: user.createdAt,
    };
  }
  private connection(): AccountConnection {
    if (!this.accountConnection)
      throw new HostError(422, "Start the host with --aws-region to manage competitor accounts.");
    return this.accountConnection;
  }
  private registerAccount(
    body: Record<string, unknown>,
    operation: AuditOperation | undefined,
  ): CompetitorAccount {
    const connection = this.connection();
    const awsAccountId = text(body.awsAccountId, "awsAccountId", 12);
    if (!awsAccountPattern.test(awsAccountId))
      throw new HostError(422, "Use a 12-digit AWS account ID.");
    if (operation) operation.resource = { kind: "account", id: awsAccountId };
    if (awsAccountId === connection.operatorAccountId)
      throw new HostError(422, "The operator account cannot be a competitor account.");
    const region = body.region === undefined ? connection.region : text(body.region, "region", 32);
    if (region !== connection.region)
      throw new HostError(422, `This host deploys AWS problems in ${connection.region}.`);
    const competitorRoleName =
      body.competitorRoleName === undefined
        ? DEFAULT_COMPETITOR_ROLE
        : text(body.competitorRoleName, "competitorRoleName", 64);
    if (!awsRoleNamePattern.test(competitorRoleName))
      throw new HostError(422, "Invalid competitor IAM role name.");
    const alias = body.alias === undefined ? undefined : text(body.alias, "alias", 120);
    if (this.store.accounts().some((account) => account.awsAccountId === awsAccountId))
      throw new HostError(409, "Competitor account is already registered.");
    const now = new Date(this.now()).toISOString();
    const account: CompetitorAccount = {
      awsAccountId,
      region,
      competitorRoleName,
      ...(alias ? { alias } : {}),
      verified: false,
      createdAt: now,
      updatedAt: now,
    };
    return this.audit.commit(operation, () => {
      this.store.putAccount(account);
      return account;
    });
  }
  private accountRoute(
    request: ApiRequest,
    principal: OrganizerPrincipal,
    operation: AuditOperation | undefined,
  ): ApiResponse | Promise<ApiResponse> {
    if (request.path === "/admin/competitor-accounts" && request.method === "GET")
      return ok({ items: this.store.accounts() });
    requireRole(principal, "manage-connections");
    if (request.path === "/admin/competitor-accounts" && request.method === "POST") {
      const account = this.registerAccount(object(request.body), operation);
      const cloud = this.connection();
      return ok(
        { ...account, externalId: cloud.externalId, tenkaCloudAccountId: cloud.operatorAccountId },
        201,
      );
    }
    if (request.path === "/admin/competitor-accounts/bulk" && request.method === "POST")
      return this.bulkRegisterAccounts(object(request.body), operation);
    const match = /^\/admin\/competitor-accounts\/(\d{12})(?:\/(verify))?$/u.exec(request.path);
    if (!match) throw new HostError(404, "Unknown host endpoint.");
    const accountId = match[1];
    if (!accountId) throw new HostError(404, "Unknown host endpoint.");
    if (request.method === "POST" && match[2] === "verify")
      return this.verifyAccount(accountId, request.token, operation);
    if (request.method === "DELETE" && !match[2])
      return this.deleteAccount(accountId, request.token, operation);
    throw new HostError(404, "Unknown host endpoint.");
  }
  private bulkRegisterOne(
    value: unknown,
    defaults: Record<string, unknown>,
    operation: AuditOperation | undefined,
  ) {
    const awsAccountId =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "awsAccountId" in value &&
      typeof value.awsAccountId === "string"
        ? value.awsAccountId
        : "";
    try {
      this.registerAccount({ ...defaults, ...object(value) }, operation);
      return { awsAccountId, outcome: "created" as const };
    } catch (error) {
      if (operation) this.audit.observe({ ...operation, phase: "request", ...auditFailure(error) });
      const status = error instanceof HostError ? error.status : 500;
      let outcome: "duplicate" | "invalid" | "failed" = "failed";
      if (status === 409) outcome = "duplicate";
      else if (status < 500) outcome = "invalid";
      return {
        awsAccountId,
        outcome,
        message: error instanceof HostError ? error.message : "Registration failed.",
      };
    }
  }
  private bulkRegisterAccounts(
    body: Record<string, unknown>,
    operation: AuditOperation | undefined,
  ): ApiResponse {
    if (!Array.isArray(body.accounts) || body.accounts.length < 1 || body.accounts.length > 100)
      throw new HostError(400, "Choose 1–100 competitor accounts.");
    const defaults = body.defaults === undefined ? {} : object(body.defaults);
    const results = body.accounts.map((value: unknown) =>
      this.bulkRegisterOne(value, defaults, operation ? { ...operation } : undefined),
    );
    const created = results.filter((result) => result.outcome === "created").length;
    const cloud = this.connection();
    return ok({
      results,
      created,
      duplicate: results.filter((result) => result.outcome === "duplicate").length,
      invalid: results.filter((result) => result.outcome === "invalid").length,
      failed: results.filter((result) => result.outcome === "failed").length,
      ...(created ? { externalId: cloud.externalId } : {}),
      tenkaCloudAccountId: cloud.operatorAccountId,
    });
  }
  private verifyAccount(
    accountId: string,
    token: string,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse> {
    return this.queue.run(`account:${accountId}`, async () => {
      requireRole(this.store.authenticateAdmin(token, this.now()), "manage-connections");
      const account = this.store.account(accountId);
      const cloud = this.connection();
      try {
        await cloud.verify(account.awsAccountId, account.competitorRoleName);
      } catch {
        const current = this.store.authenticateAdmin(token, this.now());
        if (operation) operation.actor = auditActor(current);
        requireRole(current, "manage-connections");
        const updatedAt = new Date(this.now()).toISOString();
        this.store.putAccount({ ...account, verified: false, verifiedAt: undefined, updatedAt });
        throw new HostError(
          422,
          "Could not verify the competitor role. Check the account, role, ExternalId, and operator trust.",
        );
      }
      const current = this.store.authenticateAdmin(token, this.now());
      if (operation) operation.actor = auditActor(current);
      requireRole(current, "manage-connections");
      const verifiedAt = new Date(this.now()).toISOString();
      const verified = { ...account, verified: true, verifiedAt, updatedAt: verifiedAt };
      return this.audit.commit(operation, () => {
        this.store.putAccount(verified);
        return ok(verified);
      });
    });
  }
  private deleteAccount(
    accountId: string,
    token: string,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse> {
    return this.queue.run(`account:${accountId}`, async () => {
      const current = this.store.authenticateAdmin(token, this.now());
      if (operation) operation.actor = auditActor(current);
      requireRole(current, "manage-connections");
      this.store.account(accountId);
      if (this.store.accountReferenced(accountId))
        throw new HostError(
          409,
          "Competitor account is assigned to an event or has resources awaiting cleanup.",
        );
      return this.audit.commit(operation, () => {
        this.store.deleteAccount(accountId);
        return ok({ deleted: true });
      });
    });
  }
  private createEvent(
    body: Record<string, unknown>,
    operation: AuditOperation | undefined,
  ): ApiResponse {
    const name = text(body.name, "name");
    if (!Array.isArray(body.teams) || body.teams.length < 1 || body.teams.length > MAX_JOBS)
      throw new HostError(400, "Choose 1–40 teams.");
    if (
      !Array.isArray(body.problems) ||
      body.problems.length < 1 ||
      body.problems.length > MAX_JOBS
    )
      throw new HostError(400, "Choose at least one supported problem.");
    const catalog = this.engine.catalog();
    const problems = body.problems.map((value) => {
      const problemId = text(object(value).problemId, "problemId");
      const problem = catalog.find((candidate) => candidate.problemId === problemId);
      if (!problem)
        throw new HostError(422, `Problem is not supported by local hosting: ${problemId}`);
      return { ...problem };
    });
    if (problems.filter((problem) => problem.runtime === "coordination").length > 1)
      throw new HostError(422, "Choose at most one coordination Battle per event.");
    if (new Set(problems.map((problem) => problem.problemId)).size !== problems.length)
      throw new HostError(400, "Duplicate problem.");
    if (body.teams.length * problems.length > MAX_JOBS)
      throw new HostError(
        422,
        "Local hosting supports at most 40 simultaneous team/problem environments.",
      );
    this.assertGatewayCapacity(
      body.teams.length *
        problems.filter((problem) => this.needsGateway(problem.definition)).length,
    );
    const timestamp = this.now();
    const eventId = id(timestamp);
    const needsAws = problems.some((problem) => problem.runtime === "cloudformation");
    const teams: Team[] = body.teams.map((value) => {
      const internalSlug = text(object(value).internalSlug, "internalSlug", 40);
      if (!slugPattern.test(internalSlug))
        throw new HostError(400, "Use lowercase letters, digits and hyphens for team slugs.");
      const aws = needsAws ? this.awsTarget(object(value), internalSlug) : undefined;
      return {
        ...(aws ? { aws } : {}),
        teamId: id(timestamp),
        eventId,
        internalSlug,
        displayName: internalSlug,
        loginKey: randomToken(),
        snapshot: null,
        score: 0,
        completedProblems: 0,
        scoreEvents: [],
      };
    });
    if (new Set(teams.map((team) => team.internalSlug)).size !== teams.length)
      throw new HostError(400, "Duplicate team slug.");
    const event: HostedEvent = {
      eventId,
      name,
      status: "DRAFT",
      createdAt: new Date(timestamp).toISOString(),
      updatedAt: new Date(timestamp).toISOString(),
      expiresAt: Math.floor(timestamp / 1000) + 365 * 24 * 3600,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems,
    };
    if (operation) operation.resource = { kind: "event", id: eventId };
    this.audit.commit(operation, () => {
      this.store.putEvent(event);
      for (const team of teams) this.store.putTeam(team);
    });
    return ok(
      {
        ...this.summary(event),
        problems: problems.map((problem) => ({
          problemId: problem.problemId,
          defaultRegion: "local",
        })),
        teams: teams.map((team) => ({
          teamId: team.teamId,
          internalSlug: team.internalSlug,
          teamLoginKey: team.loginKey,
        })),
      },
      201,
    );
  }
  private awsTarget(team: Record<string, unknown>, internalSlug: string): AwsTarget {
    const accountId = team.awsAccountId;
    if (typeof accountId !== "string" || !awsAccountPattern.test(accountId))
      throw new HostError(422, `Team ${internalSlug} needs a registered AWS account.`);
    if (team.awsRoleName !== undefined)
      throw new HostError(
        422,
        "Select a registered account; event requests cannot override its IAM role.",
      );
    if (team.region !== undefined && team.region !== this.connection().region)
      throw new HostError(422, `This host deploys AWS problems in ${this.connection().region}.`);
    const account = this.store.accounts().find((candidate) => candidate.awsAccountId === accountId);
    if (!account) throw new HostError(422, `Competitor account ${accountId} is not registered.`);
    if (!account.verified)
      throw new HostError(
        422,
        `Competitor account ${accountId} must be verified before event creation.`,
      );
    if (account.region !== this.connection().region)
      throw new HostError(422, `Competitor account ${accountId} is registered in another region.`);
    return { accountId, roleName: account.competitorRoleName };
  }
  private async mutateEvent(
    event: HostedEvent,
    parts: string[],
    request: ApiRequest,
    operation: AuditOperation | undefined,
    principal: OrganizerPrincipal,
  ): Promise<ApiResponse> {
    const disruption = this.disruptions.route(event, parts, request, principal, operation);
    if (disruption) return disruption;
    if (this.busyEvents.has(event.eventId))
      throw new HostError(409, "An environment operation is already in progress.");
    const body = () => object(request.body);
    const commands: Record<string, () => ApiResponse> = {
      "PUT progression-gate": () => ok(this.progression.configure(event, request.body)),
      "DELETE progression-gate": () => ok(this.progression.configure(event, undefined, true)),
      "PATCH schedule": () => this.schedule(event, body()),
      "POST end": () => this.end(event),
      "POST lock-scoring": () => this.lockScoring(event, true),
      "DELETE lock-scoring": () => this.lockScoring(event, false),
      "POST archive": () => this.archive(event),
      "POST notifications": () => this.notify(event, body()),
    };
    const commandKey = `${request.method} ${parts.join("/")}`;
    if (commandKey === "PUT registration")
      return ok(
        this.registration.configure(event.eventId, request.body, () => {
          if (operation)
            this.audit.append({ ...operation, phase: "request", outcome: "succeeded" });
        }),
      );
    if (commandKey === "POST deploy") return this.deploy(event, body(), request.token, operation);
    if (commandKey === "DELETE ") return this.teardown(event, operation);
    const command = commands[commandKey];
    if (command) return this.audit.commit(operation, command);
    if (
      parts.length === 3 &&
      parts[0] === "teams" &&
      parts[2] === "rotate-login-key" &&
      request.method === "POST"
    )
      return this.audit.commit(operation, () => this.rotateTeamKey(event, parts[1] ?? ""));
    const jobCommand = jobOperation(parts, request.method);
    if (jobCommand) return this.operateJob(event, parts[1] ?? "", jobCommand, operation);
    throw new HostError(404, "This operation is not available in local hosting.");
  }
  private eventHasBusyJob(eventId: string): boolean {
    return [...this.busyJobs.values()].includes(eventId);
  }
  /** Stop, restart or tear down exactly one team/problem environment of this event. */
  private operateJob(
    event: HostedEvent,
    jobId: string,
    operation: JobOperation,
    auditOperation: AuditOperation | undefined,
  ): ApiResponse {
    if (!jobPattern.test(jobId)) throw new HostError(404, "Deployment not found in this event.");
    const job = this.store.job(jobId);
    // The job identifier is not a capability: it must belong to the event in the path.
    if (job.eventId !== event.eventId)
      throw new HostError(404, "Deployment not found in this event.");
    if (this.busyJobs.has(jobId) || job.operation)
      throw new HostError(409, "An operation on this environment is already in progress.");
    assertJobOperation(event, job, operation);
    job.operation = operation;
    this.audit.accept(auditOperation, [jobId], () => this.store.putJob(job));
    this.busyJobs.set(jobId, event.eventId);
    this.track(
      this.runJobOperation(jobId, operation).finally(() => this.busyJobs.delete(jobId)),
      event.eventId,
    );
    return ok({ eventId: event.eventId, jobId, operation }, 202);
  }
  private async runJobOperation(jobId: string, operation: JobOperation): Promise<void> {
    const job = this.store.job(jobId);
    if (operation === "restart" && (job.status === "FAILED" || job.status === "DELETED")) {
      // A missing or failed environment is rebuilt exactly like a deployment retry. The
      // operation marker stays until the rebuild has finished.
      await this.startJob(jobId);
      this.finishOperation(jobId);
    } else {
      // Persist a non-linkable state before the gateway is closed, so no portal poll can
      // reopen it while the environment changes (the `operation` marker is already stored).
      if (operation === "restart") job.status = "IN_PROGRESS";
      if (operation === "teardown") job.status = "DELETING";
      this.store.putJob(job);
      try {
        await this.closeSurface?.(job.jobId);
        await this.changeEnvironment(job, operation);
        job.error = undefined;
      } catch (error) {
        job.status = "FAILED";
        job.error = failureMessage(error, "Environment operation failed; ownership retained.");
      }
      job.operation = undefined;
      this.store.putJob(job);
    }
    this.audit.settleJob(jobId, this.store.job(jobId).status);
    this.promoteIfDeployed(job.eventId);
  }
  /** Stop, resume or remove the runtime in place; `job` records the resulting state. */
  private async changeEnvironment(job: Job, operation: JobOperation): Promise<void> {
    if (operation === "stop") {
      await this.engine.pause(job);
      job.status = "STOPPED";
    } else if (operation === "restart") {
      await this.engine.resume(job);
      job.status = "COMPLETE";
    } else {
      if (job.unit) await this.engine.stop(job);
      job.unit = null;
      job.status = "DELETED";
    }
  }
  private finishOperation(jobId: string): void {
    const job = this.store.job(jobId);
    job.operation = undefined;
    this.store.putJob(job);
  }
  /** A deploying event becomes ready once every one of its environments is running. */
  private promoteIfDeployed(eventId: string): void {
    const event = this.store.event(eventId);
    if (event.status !== "DEPLOYING") return;
    if (this.store.jobs(eventId).every((job) => job.status === "COMPLETE")) {
      event.status = "READY";
      this.saveEvent(event);
    }
  }
  private saveEvent(event: HostedEvent): void {
    event.updatedAt = new Date(this.now()).toISOString();
    this.store.putEvent(event);
  }
  private end(event: HostedEvent): ApiResponse {
    if (event.status !== "READY") throw new HostError(409, "Only a ready event can end.");
    this.coordination.settle(event);
    event.status = "ENDED";
    event.endsAt = new Date(this.now()).toISOString();
    this.saveEvent(event);
    return ok({
      endsAt: event.endsAt,
      updatedDeployments: this.store.jobs(event.eventId).length,
    });
  }
  private lockScoring(event: HostedEvent, locked: boolean): ApiResponse {
    if (!["READY", "ENDED"].includes(event.status))
      throw new HostError(409, "Event is not lockable.");
    if (event.scoringLocked === locked)
      return ok({ scoringLocked: event.scoringLocked, scoringLockedAt: event.scoringLockedAt });
    this.coordination.settle(event);
    this.coordination.accountUnlock(event, locked);
    event.scoringLocked = locked;
    event.scoringLockedAt = locked ? new Date(this.now()).toISOString() : undefined;
    this.saveEvent(event);
    return ok({ scoringLocked: event.scoringLocked, scoringLockedAt: event.scoringLockedAt });
  }
  private archive(event: HostedEvent): ApiResponse {
    if (!["DRAFT", "ENDED", "TEARDOWN"].includes(event.status))
      throw new HostError(409, "Event is not archivable.");
    if (this.store.jobs(event.eventId).some((job) => job.unit))
      throw new HostError(409, "Tear down all environments before archiving.");
    event.status = "ARCHIVED";
    this.saveEvent(event);
    return ok({ archivedAt: event.updatedAt });
  }
  private notify(event: HostedEvent, body: Record<string, unknown>): ApiResponse {
    const severity = body.severity ?? "info";
    if (severity !== "info" && severity !== "warning")
      throw new HostError(400, "Invalid notification severity.");
    const notificationId = id(this.now());
    const occurredAt = new Date(this.now()).toISOString();
    this.store.notify(event.eventId, notificationId, {
      notificationId,
      occurredAt,
      title: text(body.title, "title"),
      body: text(body.body, "body", 2000),
      severity,
    });
    return ok({ notificationId, occurredAt });
  }
  private rotateTeamKey(event: HostedEvent, teamId: string): ApiResponse {
    const team = this.store.team(teamId);
    if (team.eventId !== event.eventId) throw new HostError(404, "Team not found in this event.");
    team.loginKey = randomToken();
    this.store.putTeam(team);
    return ok({
      kind: "ok",
      teamId: team.teamId,
      teamLoginKey: team.loginKey,
      rotatedAt: new Date(this.now()).toISOString(),
    });
  }
  private schedule(event: HostedEvent, body: Record<string, unknown>): ApiResponse {
    if (event.status !== "READY")
      throw new HostError(409, "Deploy the event before scheduling it.");
    if (
      Object.keys(body).some(
        (key) => !["startNow", "startsAt", "endsAt", "scoreboardFreezeMinutes"].includes(key),
      )
    )
      throw new HostError(422, "Automatic deploy/teardown schedules are not supported locally.");
    if (body.startNow !== undefined && body.startNow !== true)
      throw new HostError(400, "startNow must be true.");
    if (body.startNow && body.startsAt !== undefined)
      throw new HostError(400, "Choose startNow or startsAt, not both.");
    const parseTime = (value: unknown): string => {
      const input = text(value, "timestamp", 40);
      const milliseconds = Date.parse(input);
      if (
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(input) ||
        !Number.isFinite(milliseconds)
      )
        throw new HostError(400, "An ISO timestamp with a timezone is required.");
      return new Date(milliseconds).toISOString();
    };
    this.coordination.assertSchedule(event, body);
    if (body.startNow) event.startsAt = new Date(this.now()).toISOString();
    if (body.startsAt !== undefined) event.startsAt = parseTime(body.startsAt);
    if (body.endsAt !== undefined) event.endsAt = parseTime(body.endsAt);
    if (event.startsAt && event.endsAt && Date.parse(event.endsAt) <= Date.parse(event.startsAt))
      throw new HostError(400, "The end must be after the start.");
    if (body.scoreboardFreezeMinutes !== undefined) {
      const minutes = body.scoreboardFreezeMinutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 180)
        throw new HostError(400, "Freeze minutes must be an integer from 0 to 180.");
      event.scoreboardFreezeMinutes = minutes;
    }
    this.saveEvent(event);
    return ok({
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      updatedDeployments: this.store.jobs(event.eventId).length,
    });
  }
  /**
   * Never-started teardown recovery: an end time already in the past would end the re-prepared
   * event the moment it started.
   */
  private clearPastEnd(event: HostedEvent): void {
    if (event.endsAt && Date.parse(event.endsAt) <= this.now()) event.endsAt = undefined;
  }
  /**
   * Whether every host port a slot needs is free: the problem's published ports on loopback
   * (where Compose binds them) and its exercise gateway on the gateways' listen address.
   */
  private needsGateway(definition: string): boolean {
    return this.engine.requiresGateway?.(definition) ?? true;
  }
  private async slotFree(definition: string, offset: number): Promise<boolean> {
    const runtime = portsFree(this.engine.hostPorts?.(definition, offset) ?? [], "127.0.0.1");
    const gateway = this.gatewayPorts
      ? portsFree([gatewayPort(this.gatewayPorts, offset)], this.gatewayHostname)
      : Promise.resolve(true);
    const [runtimeFree, gatewayFree] = await Promise.all([runtime, gateway]);
    return runtimeFree && gatewayFree;
  }
  /** False when the host restarted with a narrower --gateway-ports range than this slot needs. */
  private slotInRange(offset: number): boolean {
    const slot = offset / SLOT_STRIDE;
    const slots = this.gatewayPorts ? gatewaySlots(this.gatewayPorts) : MAX_JOBS;
    return Number.isInteger(slot) && slot >= 1 && slot <= slots;
  }
  /** Environments the gateway range can serve; named in the refusal so it can be widened. */
  private assertGatewayCapacity(environments: number): void {
    if (this.gatewayPorts && environments > gatewaySlots(this.gatewayPorts))
      throw new HostError(
        422,
        `This event needs ${String(environments)} exercise gateway ports, but --gateway-ports ${formatGatewayPorts(this.gatewayPorts)} provides ${String(gatewaySlots(this.gatewayPorts))}. Restart the host with a wider --gateway-ports range.`,
      );
  }
  /**
   * The gateway range must not overlap any runtime port a supported problem publishes in any
   * slot; otherwise a gateway and a team's exercise would compete for one port.
   */
  assertGatewayRange(range: GatewayPortRange): void {
    for (const problem of this.engine.catalog())
      for (let slot = 1; slot <= MAX_JOBS; slot += 1)
        for (const port of this.engine.hostPorts?.(problem.definition, slot * SLOT_STRIDE) ?? [])
          if (port >= range.start && port <= range.end)
            throw new Error(
              `--gateway-ports ${formatGatewayPorts(range)} overlaps port ${String(port)} that ${problem.problemId} publishes for runtime slot ${String(slot)}. Choose a range such as 5200-5239.`,
            );
  }
  /** Offsets recorded for live jobs in this database, optionally ignoring one job. */
  private recordedOffsets(except?: string): Set<number> {
    return new Set(
      this.store
        .jobs()
        .filter(
          (job) =>
            job.status !== "DELETED" && job.jobId !== except && this.needsGateway(job.definition),
        )
        .map((job) => job.offset),
    );
  }
  /**
   * The lowest free port block whose host ports are actually unbound. SQLite only knows this
   * host's own jobs; an unrelated process, another data directory's containers or a lazily
   * allocated exercise gateway can hold a block that no recorded job owns.
   */
  private async freeSlot(definition: string, occupied: Set<number>): Promise<number> {
    if (!this.needsGateway(definition)) return 0;
    const slots = this.gatewayPorts ? gatewaySlots(this.gatewayPorts) : MAX_JOBS;
    for (let index = 1; index <= slots; index += 1) {
      const offset = index * SLOT_STRIDE;
      if (occupied.has(offset)) continue;
      if (await this.slotFree(definition, offset)) {
        occupied.add(offset);
        return offset;
      }
    }
    throw new HostError(
      422,
      "No free runtime port blocks. Tear down another event or stop the processes holding the local ports.",
    );
  }
  private async deploy(
    event: HostedEvent,
    body: Record<string, unknown>,
    token: string,
    operation: AuditOperation | undefined,
  ): Promise<ApiResponse> {
    // A torn-down event that never started (for example after a failed first deployment) can
    // be prepared again; an event that already ran is final and needs a new event instead.
    const redeployable = event.status === "TEARDOWN" && !event.startsAt;
    if (!["DRAFT", "DEPLOYING"].includes(event.status) && !redeployable)
      throw new HostError(
        409,
        event.status === "TEARDOWN"
          ? "This event already ran and was torn down. Create a new event to host again."
          : "This event has already been deployed.",
      );
    if (this.eventHasBusyJob(event.eventId))
      throw new HostError(409, "A team environment operation is still in progress.");
    if (
      Object.keys(body).some((key) => key !== "retryFailedOnly") ||
      (body.retryFailedOnly !== undefined && body.retryFailedOnly !== true)
    )
      throw new HostError(
        422,
        "Only full deployment or failed-environment retry is supported locally.",
      );
    const teams = this.store.teams(event.eventId);
    const existing = this.store.jobs(event.eventId);
    const failedOnly = body.retryFailedOnly === true;
    this.assertGatewayCapacity(
      teams.length *
        event.problems.filter((problem) => this.needsGateway(problem.definition)).length,
    );
    // Slot allocation reads every event's jobs, so serialize it across events too.
    const targets = await this.queue.run(SLOT_QUEUE, async () => {
      const occupied = this.recordedOffsets();
      const planned: Job[] = [];
      for (const team of teams)
        for (const problem of event.problems) {
          const previous = existing.find(
            (job) => job.teamId === team.teamId && job.problemId === problem.problemId,
          );
          const plan = deploymentPlan(previous, failedOnly);
          if (plan === "skip") continue;
          if (previous) {
            planned.push(previous);
            continue;
          }
          planned.push({
            jobId: id(this.now()),
            eventId: event.eventId,
            teamId: team.teamId,
            problemId: problem.problemId,
            definition: problem.definition,
            offset: await this.freeSlot(problem.definition, occupied),
            status: "PENDING",
            unit: null,
          });
        }
      this.store.transaction(() => {
        const current = this.store.authenticateAdmin(token, this.now());
        if (operation) operation.actor = auditActor(current);
        requireRole(current, "run-events");
        if (redeployable) this.clearPastEnd(event);
        event.status = "DEPLOYING";
        this.audit.accept(
          operation,
          planned.map((job) => job.jobId),
          () => {
            this.saveEvent(event);
            for (const job of planned) this.store.putJob(job);
          },
        );
      });
      return planned;
    });
    this.launch(event.eventId, async () => {
      for (const original of targets) await this.startJob(original.jobId);
      const latest = this.store.event(event.eventId);
      if (this.store.jobs(event.eventId).every((job) => job.status === "COMPLETE"))
        latest.status = "READY";
      this.saveEvent(latest);
    });
    return ok(
      {
        eventId: event.eventId,
        enqueued: targets.length,
        skipped:
          existing.length -
          targets.filter((job) => existing.some((prior) => prior.jobId === job.jobId)).length,
      },
      202,
    );
  }
  private async startJob(jobId: string): Promise<void> {
    const job = this.store.job(jobId);
    try {
      // Always: a gateway opened for this job's previous runtime must not outlive it, even when
      // the runtime itself is already gone.
      await this.closeSurface?.(job.jobId);
      if (job.unit) {
        await this.engine.stop(job);
        job.unit = null;
        this.store.putJob(job);
      }
      // A retry keeps its block unless something else took the ports in the meantime, or a
      // removed environment's block was recorded for another environment since.
      if (
        this.needsGateway(job.definition) &&
        (!this.slotInRange(job.offset) ||
          !(await this.slotFree(job.definition, job.offset)) ||
          this.recordedOffsets(job.jobId).has(job.offset))
      ) {
        job.offset = await this.queue.run(SLOT_QUEUE, () =>
          this.freeSlot(job.definition, this.recordedOffsets(job.jobId)),
        );
      }
      job.deployedAt = undefined;
      job.status = "IN_PROGRESS";
      job.error = undefined;
      this.store.putJob(job);
      await this.engine.start(job, (unit) => {
        job.unit = unit;
        this.store.putJob(job);
      });
      job.status = "COMPLETE";
      job.deployedAt = this.now();
    } catch (error) {
      job.status = "FAILED";
      job.error = failureMessage(error, "Runtime failed.");
    }
    this.store.putJob(job);
    this.audit.settleJob(jobId, job.status);
  }
  private teardown(event: HostedEvent, operation: AuditOperation | undefined): ApiResponse {
    if (event.status === "ARCHIVED")
      throw new HostError(409, "An archived event has no environments to remove.");
    // A torn-down event only accepts a retry while some cleanup is still owed.
    if (
      event.status === "TEARDOWN" &&
      this.store.jobs(event.eventId).every((job) => job.status === "DELETED")
    )
      throw new HostError(409, "Every environment of this event has already been removed.");
    if (this.eventHasBusyJob(event.eventId))
      throw new HostError(409, "A team environment operation is still in progress.");
    const jobs = this.store.jobs(event.eventId);
    this.audit.accept(
      operation,
      jobs.filter((job) => job.status !== "DELETED").map((job) => job.jobId),
      () => {
        this.coordination.settle(event);
        event.status = "TEARDOWN";
        if (event.startsAt) event.endsAt ??= new Date(this.now()).toISOString();
        this.saveEvent(event);
        for (const job of jobs) {
          if (job.status === "DELETED") continue;
          job.status = "DELETING";
          this.store.putJob(job);
        }
      },
    );
    this.launch(event.eventId, async () => {
      for (const job of jobs) {
        if (job.status === "DELETED") continue;
        job.status = "DELETING";
        this.store.putJob(job);
        try {
          await this.closeSurface?.(job.jobId);
          if (job.unit) await this.engine.stop(job);
          job.unit = null;
          job.error = undefined;
          job.status = "DELETED";
        } catch (error) {
          job.status = "FAILED";
          job.error = failureMessage(error, "Cleanup failed; ownership retained.");
        }
        this.store.putJob(job);
        this.audit.settleJob(job.jobId, job.status);
      }
    });
    return ok(
      {
        eventId: event.eventId,
        enqueued: jobs.filter((job) => job.status !== "DELETED").length,
        skipped: jobs.filter((job) => job.status === "DELETED").length,
      },
      202,
    );
  }
  private launch(eventId: string, operation: () => Promise<void>): void {
    this.busyEvents.add(eventId);
    this.track(
      Promise.resolve()
        .then(operation)
        .finally(() => this.busyEvents.delete(eventId)),
      eventId,
    );
  }
  /** Background work is logged when it fails and awaited by `drain()` before shutdown. */
  private track(work: Promise<void>, eventId: string): void {
    const task: Promise<void> = work
      .catch((error: unknown) => {
        this.log(
          `Local-host operation failed for ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }
  async drain(): Promise<void> {
    await Promise.all([...this.tasks]);
    await this.disruptions.drain();
  }
  /** Writes Battle state held in memory; call it after `drain()` and before closing SQLite. */
  flush(): void {
    this.coordination.flush();
  }
  /**
   * Re-adopt recorded runtimes before the listeners open. Jobs recover concurrently: each
   * unreachable environment costs one readiness timeout, not one per job, so an outage
   * affecting every environment delays the consoles by minutes rather than the better part
   * of an hour.
   */
  async recover(): Promise<void> {
    this.store.transaction(() => this.progression.captureAllEvents());
    this.disruptions.recover();
    await Promise.all(
      this.store.jobs().map(async (job) => {
        this.audit.settleJob(job.jobId, "unknown");
        await this.recoverJob(job);
        this.audit.settleJob(job.jobId, this.store.job(job.jobId).status);
      }),
    );
    for (const event of this.store.events()) {
      if (!["DEPLOYING", "READY"].includes(event.status)) continue;
      const jobs = this.store.jobs(event.eventId);
      // A ready event keeps running when the organizer deliberately stopped or removed one
      // team's environment; only an environment that was lost makes it deployable again.
      const recovered =
        jobs.length === event.problems.length * this.store.teams(event.eventId).length &&
        jobs.every(
          (job) =>
            job.status === "COMPLETE" ||
            (event.status === "READY" && INTENDED_IDLE_STATUSES.includes(job.status)),
        );
      // An event with a start time (already started or scheduled) stays ready: one lost
      // environment is repaired by its own restart instead of closing, or at the scheduled
      // time never opening, the scoring gate for every team. Only an event without a start
      // time returns to deployment, where the event-level retry is available.
      event.status =
        recovered || (event.status === "READY" && event.startsAt) ? "READY" : "DEPLOYING";
      this.saveEvent(event);
    }
  }
  private async recoverJob(job: Job): Promise<void> {
    // Resume the accepted intent before adopting an environment that may still be unchanged.
    if (job.operation) {
      if (job.operation === "stop" && definitionKind(job.definition) === "cloudformation") {
        await this.recoverUnsupportedStop(job);
        return;
      }
      await this.runJobOperation(job.jobId, job.operation);
      return;
    }
    // A stopped environment keeps its containers and ownership until it is restarted.
    if (job.status === "DELETED" || (job.status === "STOPPED" && job.unit)) return;
    if (!job.unit) {
      if (job.status === "DELETING") {
        job.status = "DELETED";
        job.error = undefined;
        this.store.putJob(job);
        return;
      }
      if (!NONTERMINAL_STATUSES.includes(job.status)) return;
      job.status = "FAILED";
      job.error =
        "Startup was interrupted before runtime ownership was acquired. Retry deployment.";
      this.store.putJob(job);
      return;
    }
    try {
      if (job.status === "DELETING") {
        await this.engine.stop(job);
        job.status = "DELETED";
        job.unit = null;
      } else {
        await this.engine.recover(job);
        job.status = "COMPLETE";
        job.error = undefined;
      }
    } catch (error) {
      job.status = "FAILED";
      job.error = failureMessage(error, "Runtime recovery failed.");
    }
    this.store.putJob(job);
  }
  private async recoverUnsupportedStop(job: Job): Promise<void> {
    // Older hosts accepted this operation before discovering that the runtime cannot
    // pause. Re-adopt the retained environment and fail only the accepted intent.
    try {
      await this.engine.recover(job);
      job.status = "COMPLETE";
      job.error = undefined;
    } catch (error) {
      job.status = "FAILED";
      job.error = failureMessage(error, "Runtime recovery failed.");
    }
    job.operation = undefined;
    this.store.putJob(job);
    this.audit.settleJob(job.jobId, "FAILED");
  }
  private context(team: Team): Context {
    return {
      event: this.currentEvent(team.eventId),
      team,
      jobs: this.store.jobs(team.eventId, team.teamId),
      now: this.now(),
    };
  }
  async participant(request: ApiRequest): Promise<ApiResponse> {
    if (request.path.startsWith("/portal/registration/")) return this.registration.request(request);
    const team = this.store.authenticateTeam(request.token);
    if (request.path.startsWith("/portal/me/coordination/")) {
      return this.queue.run(team.eventId, async () => this.coordination.request(request));
    }
    if (/^\/portal\/me\/problems\/[^/]+\/endpoints(?:\/[^/]+)?$/u.test(request.path)) {
      return this.queue.run(team.eventId, () => this.participantEndpoint(request));
    }
    if (request.method === "GET" && request.path === "/portal/me/console-signin-url")
      return this.awsAccess(request, "console");
    if (request.method === "GET" && request.path === "/portal/me/cli-credentials")
      return this.awsAccess(request, "cli");
    if (request.method === "GET")
      return this.queue.run(team.eventId, () => this.readParticipant(request));
    if (request.method === "PATCH" && request.path === "/portal/me")
      return this.queue.run(team.eventId, () => this.renameParticipant(request));
    if (request.method !== "POST") throw new HostError(404, "Unknown participant endpoint.");
    return this.submitParticipant(request, team);
  }
  private participantEndpoint(request: ApiRequest): ApiResponse {
    const team = this.store.authenticateTeam(request.token);
    const parts = request.path.split("/").filter(Boolean);
    const problemId = decodeURIComponent(parts[3] ?? "");
    const slot = parts[5] ? decodeURIComponent(parts[5]) : undefined;
    this.progression.assertAccess(team, problemId);
    if (request.method === "GET" && !slot) return ok(this.uptime.view(team, problemId));
    if (slot && (request.method === "POST" || request.method === "DELETE"))
      return ok(
        this.uptime.change(
          team,
          problemId,
          slot,
          request.method,
          request.method === "POST" ? object(request.body).url : undefined,
        ),
      );
    throw new HostError(404, "Unknown participant endpoint.");
  }
  private async awsAccess(
    request: ApiRequest,
    kind: ParticipantAwsAccess["kind"],
  ): Promise<ApiResponse> {
    const jobId = request.query.get("jobId") ?? "";
    if (
      !jobPattern.test(jobId) ||
      request.query.getAll("jobId").length !== 1 ||
      [...request.query.keys()].some((key) => key !== "jobId")
    )
      throw new HostError(400, "Specify only one valid jobId.", "invalid_jobid");
    if (!this.engine.hasAws || !this.engine.participantAwsAccess)
      throw new HostError(503, "AWS access is not configured on this host.", "aws_not_configured");
    const resolve = () => {
      const team = this.store.authenticateTeam(request.token);
      const event = this.currentEvent(team.eventId);
      assertPlaying(event, this.now());
      if (event.expiresAt * 1000 <= this.now())
        throw new HostError(409, "This event has expired.", "scoring_ended");
      const job = this.store
        .jobs(team.eventId, team.teamId)
        .find((candidate) => candidate.jobId === jobId);
      if (!job)
        throw new HostError(403, "This environment does not belong to your team.", "unauthorized");
      this.progression.assertAccess(team, job.problemId);
      if (
        !linkable(job) ||
        !event.problems.some(
          (problem) =>
            problem.problemId === job.problemId &&
            problem.definition === job.definition &&
            problem.runtime === "cloudformation",
        )
      )
        throw new HostError(409, "This AWS environment is not running.", "not_ready");
      return { job, team };
    };
    const initial = resolve();
    const assertCurrent = () => {
      const current = resolve();
      if (
        current.job.unit !== initial.job.unit ||
        current.job.definition !== initial.job.definition ||
        current.team.aws?.accountId !== initial.team.aws?.accountId ||
        current.team.aws?.roleName !== initial.team.aws?.roleName
      )
        throw new HostError(
          409,
          "This AWS environment changed. Request access again.",
          "not_ready",
        );
    };
    try {
      const result = await this.engine.participantAwsAccess({
        kind,
        job: initial.job,
        assertCurrent,
      });
      assertCurrent();
      return ok(
        result.kind === "console"
          ? { loginUrl: result.loginUrl }
          : { credentials: result.credentials },
      );
    } catch (error) {
      if (error instanceof ParticipantAssumeRoleError)
        return ok(
          {
            error: error.kind,
            kind: error.kind,
            stage: error.stage,
            reason: "Role access denied or temporary credentials unavailable.",
            message: error.message,
          },
          error.status,
        );
      throw error;
    }
  }
  private submitParticipant(request: ApiRequest, team: Team): Promise<ApiResponse> {
    const hintMatch = /^\/portal\/me\/problems\/([^/]+)\/hints\/([^/]+)\/reveal$/u.exec(
      request.path,
    );
    if (request.path !== "/portal/me/submit-flag" && !hintMatch)
      throw new HostError(
        404,
        "Participants cannot deploy, reset or stop competition environments.",
      );
    const body = hintMatch ? {} : object(request.body);
    if (
      !hintMatch &&
      (typeof body.flag !== "string" ||
        body.flag.length > 16_384 ||
        typeof body.problemId !== "string")
    )
      throw new HostError(400, "Invalid flag submission.");
    if ("teamId" in body || "eventId" in body)
      throw new HostError(
        400,
        "Team and event identity come from authentication, not the request body.",
      );
    const action = hintMatch
      ? {
          problemId: decodeURIComponent(hintMatch[1] ?? ""),
          hintId: decodeURIComponent(hintMatch[2] ?? ""),
        }
      : { problemId: String(body.problemId) };
    return this.queue.run(team.eventId, () => this.score(request, body, action));
  }
  private async renameParticipant(request: ApiRequest): Promise<ApiResponse> {
    const latest = this.store.authenticateTeam(request.token);
    latest.displayName = text(object(request.body).teamName, "teamName", 80);
    this.store.putTeam(latest);
    return ok(await this.teamView(this.context(latest)));
  }
  private readParticipant(request: ApiRequest): Promise<ApiResponse> {
    const team = this.store.authenticateTeam(request.token);
    this.coordination.advance(this.currentEvent(team.eventId));
    return this.participantRead(this.context(this.store.team(team.teamId)), request.path);
  }
  /** Runs inside the event's serial queue: one submission or hint reveal, awarded at most once. */
  private async score(
    request: ApiRequest,
    body: Record<string, unknown>,
    action: { problemId: string; hintId?: string },
  ): Promise<ApiResponse> {
    const fresh = this.store.authenticateTeam(request.token);
    const current = this.context(fresh);
    this.progression.assertAccess(fresh, action.problemId);
    const fingerprint = digest(JSON.stringify({ path: request.path, body }));
    if (request.nonce) {
      if (!/^[A-Za-z0-9_-]{8,128}$/u.test(request.nonce))
        throw new HostError(400, "Invalid Idempotency-Key.");
      const receipt = this.store.receipt(fresh.teamId, request.nonce, fingerprint);
      if (receipt) return receipt;
    }
    assertPlaying(current.event, this.now());
    const deployed = current.jobs.some(
      (job) => job.problemId === action.problemId && job.status === "COMPLETE",
    );
    if (!deployed) throw new HostError(409, "This team's problem environment is not running.");
    const result =
      action.hintId === undefined
        ? await this.engine.submit(current, body)
        : await this.engine.hint(current, action.problemId, action.hintId);
    const latest = this.store.authenticateTeam(request.token);
    this.progression.assertAccess(latest, action.problemId);
    if (
      latest.snapshot !== fresh.snapshot ||
      JSON.stringify(latest.scoreEvents) !== JSON.stringify(fresh.scoreEvents)
    )
      throw new HostError(
        409,
        "The score changed while this action was checked. Try again.",
        "scoring_state_changed",
      );
    if (
      !this.store
        .jobs(latest.eventId, latest.teamId)
        .some((job) => job.problemId === action.problemId && linkable(job))
    )
      throw new HostError(409, "This team’s problem environment is not running.");
    if (result.status >= 400) return ok(result.body, result.status);
    // A verifier finishing after the server deadline must not award points. The
    // engine works on a disposable snapshot, so rejecting here discards its mutation.
    assertPlaying(this.currentEvent(fresh.eventId), this.now());
    const projected = projectedScore(current.event, result.scoreEvents);
    const responseBody =
      "totalScore" in result.body ? { ...result.body, totalScore: projected.total } : result.body;
    this.store.transaction(() => {
      this.store.putTeam({
        ...latest,
        snapshot: result.snapshot,
        score: projected.total,
        completedProblems: result.completedProblems,
        scoreEvents: result.scoreEvents,
      });
      this.progression.captureTeam(this.store.team(fresh.teamId));
      if (typeof responseBody.totalScore === "number")
        responseBody.totalScore = this.store.team(fresh.teamId).score;
      this.disruptions.captureTriggers(this.currentEvent(fresh.eventId));
      if (request.nonce)
        this.store.putReceipt(
          fresh.teamId,
          request.nonce,
          fingerprint,
          result.status,
          responseBody,
        );
    });
    return ok(responseBody, result.status);
  }
  private async participantRead(context: Context, path: string): Promise<ApiResponse> {
    switch (path) {
      case "/portal/me":
        return ok(await this.teamView(context));
      case "/portal/me/score-events":
        // Newest first, like the cloud endpoint.
        return ok({ entries: context.team.scoreEvents.slice(0, 100) });
      case "/portal/me/notifications":
        return ok({
          eventId: context.event.eventId,
          items: this.store.notifications(context.event.eventId),
        });
      case "/portal/me/deploy-logs":
        return ok({ entries: [], cursor: "" });
      case "/portal/leaderboard":
        return ok(this.leaderboard(context));
      case "/portal/leaderboard/score-events":
        return ok(this.leaderboardScoreEvents(context));
      default:
        throw new HostError(404, "Unknown participant endpoint.");
    }
  }
  /** Oldest first per team, teams by cumulative score: the shape the timeline chart consumes. */
  private leaderboardScoreEvents(context: Context) {
    const cutoff = this.freezeCutoff(context.event);
    const teams = this.store.teams(context.event.eventId).map((team) => {
      const events = [...team.scoreEvents]
        .reverse()
        .filter((event) => cutoff === null || Date.parse(event.occurredAt) < cutoff);
      const timeline = projectedTimeline(context.event, events);
      const projected = projectedScore(context.event, events);
      return {
        teamId: team.teamId,
        teamName: team.displayName,
        isMyTeam: team.teamId === context.team.teamId,
        events: events.map((entry, index) => ({ ...entry, projectedTotal: timeline[index] })),
        total: projected.total,
      };
    });
    teams.sort(
      (left, right) => right.total - left.total || left.teamName.localeCompare(right.teamName),
    );
    return {
      eventId: context.event.eventId,
      teams: teams.map(({ total: _total, ...team }) => team),
    };
  }
  private freezeCutoff(event: HostedEvent): number | null {
    // Ending, teardown and archival all publish the final board; only a live freeze window hides it.
    if (!event.endsAt || event.scoreboardFreezeMinutes === 0 || scoringEnded(event)) return null;
    const cutoff = Date.parse(event.endsAt) - event.scoreboardFreezeMinutes * 60_000;
    return this.now() >= cutoff ? cutoff : null;
  }
  private leaderboard(context: Context) {
    const cutoff = this.freezeCutoff(context.event);
    const entries = this.store
      .teams(context.event.eventId)
      .map((team) => {
        const historical = team.scoreEvents.filter(
          (event) => cutoff !== null && Date.parse(event.occurredAt) < cutoff,
        );
        return {
          teamId: team.teamId,
          teamName: team.displayName,
          score: cutoff === null ? team.score : projectedScore(context.event, historical).total,
          completedProblems:
            cutoff === null
              ? team.completedProblems
              : new Set(historical.filter(isSolve).map((event) => event.problemId)).size,
          totalProblems: context.event.problems.length,
          isMyTeam: team.teamId === context.team.teamId,
        };
      })
      .sort((left, right) => right.score - left.score || left.teamId.localeCompare(right.teamId));
    let rank = 1;
    return {
      eventId: context.event.eventId,
      scoreboardFrozen: cutoff !== null,
      // The portal's countdown, freeze-end timestamp and final/live result labels read this.
      ...(context.event.endsAt ? { endsAt: context.event.endsAt } : {}),
      entries: entries.map((entry, index) => {
        if (index > 0 && entry.score !== entries[index - 1]?.score) rank = index + 1;
        return { ...entry, rank };
      }),
    };
  }
  private async teamView(context: Context): Promise<Record<string, unknown>> {
    this.progression.view(context.team);
    const result = await this.engine.view(context);
    context = this.context(this.store.team(context.team.teamId));
    const projected = projectedScore(context.event, context.team.scoreEvents);
    const eventGate = gate(context.event, context.now);
    // A canceled or never-started event has nothing to reveal: writeups need a real start.
    const ended = eventGate.kind === "scoring_ended" && hasStarted(context.event, context.now);
    const problems = Array.isArray(result.problems) ? result.problems : [];
    const runtimes = new Map(
      context.event.problems.map((each) => [each.problemId, each.runtime ?? "docker"]),
    );
    const safeProblems = await Promise.all(
      problems.map((raw) =>
        this.teamProblemView(raw, context, runtimes, eventGate.kind, ended, projected.byProblem),
      ),
    );
    const latest = this.context(this.store.team(context.team.teamId));
    const progression = this.progression.view(latest.team);
    return {
      ...result,
      progression,
      team: {
        teamId: context.team.teamId,
        eventId: context.event.eventId,
        teamName: context.team.displayName,
        teamNameSetByCompetitor: true,
      },
      problems: safeProblems.map((problem) => {
        if (progression?.lockedProblemIds.includes(String(problem.problemId)))
          return lockedProblem(problem);
        if (gate(latest.event, latest.now).kind !== "ok") problem.stackOutputs = {};
        return problem;
      }),
      eventGate: gate(latest.event, latest.now),
    };
  }
  private async teamProblemView(
    raw: unknown,
    context: Context,
    runtimes: ReadonlyMap<string, Runtime>,
    gateKind: Gate["kind"],
    ended: boolean,
    projectedByProblem: Readonly<Record<string, number>>,
  ): Promise<Record<string, unknown>> {
    const entry = object(raw);
    const runtime = runtimes.get(String(entry.problemId));
    if (!runtime) throw new Error("The runtime described a problem outside the event.");
    const problem = participantProblem(entry, runtime, gateKind, ended);
    problem.score = projectedByProblem[String(problem.problemId)] ?? 0;
    const job = context.jobs.find((candidate) => candidate.problemId === problem.problemId);
    problem.provider = PROVIDERS[runtime];
    problem.jobId = job?.jobId ?? problem.jobId;
    problem.eventStartsAt = context.event.startsAt;
    problem.eventEndsAt = context.event.endsAt;
    problem.expiresAt = context.event.expiresAt;
    // The participant contract has no organizer-stop state; "DELETED" renders as stopped.
    problem.status = job?.status === "STOPPED" ? "DELETED" : (job?.status ?? "PENDING");
    showUptimeStatus(this.store, context, problem, job);
    await this.grantAccess(problem, runtime, job, context, gateKind);
    return problem;
  }
  /**
   * A stack's outputs or a Docker exercise's Web link, only while the environment runs and the
   * event is scoring.
   */
  private async grantAccess(
    problem: Record<string, unknown>,
    runtime: Runtime,
    job: Job | undefined,
    context: Context,
    gateKind: Gate["kind"],
  ): Promise<void> {
    // The context was read before the engine view was awaited; decide on the stored job.
    const current = job && this.store.job(job.jobId);
    const open =
      current !== undefined &&
      linkable(current) &&
      gateKind === "ok" &&
      this.progression.allowed(context.team, current.problemId);
    problem.stackOutputs = runtime === "cloudformation" && open ? problem.stackOutputs : {};
    if (runtime !== "docker" || !current || !open || !this.surfaceLink) return;
    try {
      problem.stackOutputs = { Web: await this.surfaceLink(current, context.team) };
    } catch (error) {
      // One environment's gateway must not take the whole team view down. The host
      // keeps the reason; the portal shows a translated, detail-free explanation.
      this.log(
        `Exercise link for job ${current.jobId} failed: ${failureMessage(error, "unknown")}`,
      );
      problem.accessError = "link_unavailable";
    }
  }
  authorizeSurface(jobId: string, keyHash: string): Job {
    const job = this.store.job(jobId);
    const team = this.store.team(job.teamId);
    if (digest(team.loginKey) !== keyHash) throw new HostError(401, "Team access was revoked.");
    assertPlaying(this.currentEvent(job.eventId), this.now());
    this.progression.assertAccess(team, job.problemId);
    if (!linkable(job)) throw new HostError(409, "Environment is not running.");
    return job;
  }
}

/** `deployments/<jobId>/stop|restart` (POST) and `deployments/<jobId>` (DELETE). */
function jobOperation(parts: readonly string[], method: string): JobOperation | undefined {
  if (parts[0] !== "deployments") return undefined;
  if (parts.length === 2 && method === "DELETE") return "teardown";
  if (parts.length === 3 && method === "POST" && parts[2] === "stop") return "stop";
  if (parts.length === 3 && method === "POST" && parts[2] === "restart") return "restart";
  return undefined;
}

/** Explicit, explained refusals: the host console disables the same combinations. */
function assertJobOperation(event: HostedEvent, job: Job, operation: JobOperation): void {
  if (operation === "teardown") {
    if (event.status === "ARCHIVED")
      throw new HostError(409, "An archived event has no environments to remove.");
    if (job.status === "DELETED")
      throw new HostError(409, "This environment has already been removed.");
    return;
  }
  if (operation === "stop") {
    if (definitionKind(job.definition) === "cloudformation")
      throw new HostError(409, "This environment cannot be paused. Tear it down instead.");
    if (!["DEPLOYING", "READY", "ENDED"].includes(event.status))
      throw new HostError(409, "Environments of this event can no longer be stopped.");
    if (job.status !== "COMPLETE")
      throw new HostError(409, "Only a running environment can be stopped.");
    return;
  }
  if (!["DEPLOYING", "READY"].includes(event.status))
    throw new HostError(
      409,
      "Environments can be restarted only while the event is being prepared or is ready.",
    );
  if (!["COMPLETE", "STOPPED", "FAILED", "DELETED"].includes(job.status))
    throw new HostError(409, "This environment is still changing; wait for it to settle.");
}

/**
 * A running or organizer-stopped environment is never redeployed by the event-level action
 * (redeploying runs `compose down --volumes`, which would discard a stopped team's data).
 * `retryFailedOnly` restricts the action to environments whose last attempt failed.
 */
function deploymentPlan(previous: Job | undefined, failedOnly: boolean): "skip" | "deploy" {
  if (failedOnly) return previous?.status === "FAILED" ? "deploy" : "skip";
  if (previous?.status === "COMPLETE" || previous?.status === "STOPPED") return "skip";
  return "deploy";
}

/** Only a running environment that no organizer operation is changing is handed out. */
function linkable(job: Job): boolean {
  return job.status === "COMPLETE" && job.operation === undefined;
}
