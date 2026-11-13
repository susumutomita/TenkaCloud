import { z } from "zod";
import { directWebTransport } from "../direct-web-transport";

export interface BattleDeploymentFixture {
  readonly ownedLocalState: true;
  readonly host: {
    readonly adminOrigin: string;
    readonly participantOrigin: string;
    readonly organizerKey: string;
  };
  stop(): Promise<void>;
}
export interface BattleDeploymentIO {
  request(
    origin: string,
    path: string,
    token: string,
    method: string,
    body?: unknown,
  ): Promise<unknown>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface BattleRound {
  readonly adminOrigin: string;
  readonly participantOrigin: string;
  readonly organizerToken: string;
  readonly eventId: string;
  readonly teams: readonly { teamId: string; teamLoginKey: string; jobId: string }[];
}
/** Numeric loopback only, no proxy, no redirects and no implicit retry. */
export const battleDeploymentIO: BattleDeploymentIO = {
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
  async request(origin, path, token, method, body) {
    const base = new URL(origin);
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      !base.port ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      !path.startsWith("/") ||
      path.startsWith("//")
    )
      throw new Error("A direct numeric loopback Host origin is required.");
    const target = new URL(`/api${path}`, base);
    if (target.origin !== base.origin) throw new Error("Host request escaped its origin.");
    const bytes = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
    const response = await directWebTransport(target, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(bytes ? { body: bytes.buffer as ArrayBuffer } : {}),
    });
    if (!response.ok) throw new Error("Host HTTP operation failed; outcome may be unknown.");
    if (response.status === 204) return {};
    return response.json();
  },
};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const teamSchema = z.object({ teamId: id, teamLoginKey: z.string().min(1) });
const eventSchema = z.object({ eventId: id, teams: z.array(teamSchema).length(2) });
const jobsSchema = z.object({
  deploymentsByProblem: z.record(
    z.string(),
    z.array(z.object({ jobId: id, teamId: id, status: z.string() })),
  ),
});
type Teams = z.infer<typeof eventSchema>["teams"];
const problem = "hello-world-battle";

function validateTeams(teams: Teams) {
  if (
    new Set(teams.map((t) => t.teamId)).size !== 2 ||
    new Set(teams.map((t) => t.teamLoginKey)).size !== 2
  )
    throw new Error("Two distinct owned teams required.");
}
async function waitJobs(
  round: Omit<BattleRound, "teams">,
  teams: Teams,
  status: string,
  io: BattleDeploymentIO,
  expected?: ReadonlyMap<string, string>,
) {
  const end = io.now() + 240_000;
  while (io.now() < end) {
    const view = jobsSchema.parse(
      await io.request(round.adminOrigin, `/events/${round.eventId}`, round.organizerToken, "GET"),
    );
    const jobs = view.deploymentsByProblem[problem] ?? [];
    if (
      jobs.some((j) => !teams.some((t) => t.teamId === j.teamId)) ||
      new Set(jobs.map((j) => j.teamId)).size !== jobs.length ||
      new Set(jobs.map((j) => j.jobId)).size !== jobs.length
    )
      throw new Error("Foreign or duplicate Battle job.");
    if (expected && jobs.some((j) => expected.get(j.teamId) !== j.jobId))
      throw new Error("Battle job identity changed.");
    if (jobs.some((j) => j.status === "FAILED")) throw new Error("Battle deployment failed.");
    if (io.now() >= end) break;
    if (jobs.length === 2 && jobs.every((j) => j.status === status))
      return teams.map((t) => ({
        ...t,
        jobId: jobs.find((j) => j.teamId === t.teamId)?.jobId ?? "",
      }));
    await io.sleep(1000);
  }
  throw new Error(`Battle did not reach ${status}.`);
}

/** Refuse shared state before changing the synthetic fixture account. */
async function prepareAccount(
  fixture: BattleDeploymentFixture,
  io: BattleDeploymentIO,
  token: string,
) {
  if (fixture.ownedLocalState !== true) throw new Error("Fresh owned local Host state required.");
  const origin = fixture.host.adminOrigin;
  const route = "/admin/competitor-accounts";
  const existing = z
    .object({ items: z.array(z.unknown()) })
    .parse(await io.request(origin, route, token, "GET"));
  if (existing.items.length) throw new Error("Refusing account setup in nonempty Host state.");
  const account = {
    awsAccountId: "000000000000",
    competitorRoleName: "TenkaCloud-SimulatorDeploy-Role",
  };
  const registered = z.object({ awsAccountId: z.literal(account.awsAccountId) });
  registered.parse(await io.request(origin, route, token, "POST", account));
  registered
    .extend({ verified: z.literal(true) })
    .parse(await io.request(origin, `${route}/${account.awsAccountId}/verify`, token, "POST"));
}

/** Creates and deletes only its own event. Physical VM cleanup is never inferred from job state. */
export async function rehearseBattleDeployment(
  fixture: BattleDeploymentFixture,
  io: BattleDeploymentIO = battleDeploymentIO,
  observe?: (round: BattleRound) => Promise<void>,
) {
  let owned: Omit<BattleRound, "teams"> | undefined;
  let teams: Teams | undefined;
  let completed: BattleRound["teams"] | undefined;
  const failures: unknown[] = [];
  try {
    const { idToken } = z.object({ idToken: z.string().min(1) }).parse(
      await io.request(fixture.host.adminOrigin, "/host/login", "", "POST", {
        key: fixture.host.organizerKey,
      }),
    );
    await prepareAccount(fixture, io, idToken);
    const response = await io.request(fixture.host.adminOrigin, "/events", idToken, "POST", {
      name: "Owned local Simulator Battle rehearsal",
      teams: [
        { internalSlug: "alpha", awsAccountId: "000000000000" },
        { internalSlug: "beta", awsAccountId: "000000000000" },
      ],
      problems: [{ problemId: problem }],
    });
    const eventId = z.object({ eventId: id }).parse(response).eventId;
    owned = {
      adminOrigin: fixture.host.adminOrigin,
      participantOrigin: fixture.host.participantOrigin,
      organizerToken: idToken,
      eventId,
    };
    teams = eventSchema.parse(response).teams;
    validateTeams(teams);
    await io.request(owned.adminOrigin, `/events/${eventId}/deploy`, idToken, "POST", {});
    completed = await waitJobs(owned, teams, "COMPLETE", io);
    if (observe) await observe({ ...owned, teams: completed });
  } catch (error) {
    failures.push(error);
  } finally {
    if (owned) {
      try {
        await deleteOwned(owned, teams, completed, io);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await fixture.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Battle rehearsal incomplete; preserve cleanup evidence.");
  if (!owned || !completed) throw new Error("Battle deployment evidence missing.");
  return {
    kind: "owned-two-team-deployment-and-logical-cleanup",
    eventId: owned.eventId,
    teamIds: completed.map((t) => t.teamId),
    jobIds: completed.map((t) => t.jobId),
    acceptancePassed: false,
    runtimeCleanupVerified: false,
  };
}

async function deleteOwned(
  owned: Omit<BattleRound, "teams">,
  teams: Teams | undefined,
  completed: BattleRound["teams"] | undefined,
  io: BattleDeploymentIO,
) {
  await io.request(owned.adminOrigin, `/events/${owned.eventId}`, owned.organizerToken, "DELETE");
  if (!teams) throw new Error("Deleted event requested but team identity was not confirmed.");
  const expected = completed ? new Map(completed.map((t) => [t.teamId, t.jobId])) : undefined;
  await waitJobs(owned, teams, "DELETED", io, expected);
}
