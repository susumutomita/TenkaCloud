import { vi } from "vitest";
import type {
  LeaderboardResponse,
  LeaderboardScoreEventsResponse,
  NotificationsResponse,
  ParticipantProblemView,
  ParticipantTeamView,
  ScoreEventsResponse,
} from "../../src/api/portal-client";

// Synthetic HTTP responses, not an AWS rehearsal. Shapes and paths follow the restored
// participant-portal-hosting.ts and participant-handler/{lookup,index,registration,sso}.ts.
// The real config loader, auth, clients, router and UI consume these serialized responses.
export const cloudRuntime = {
  apiBaseUrl: "https://participant-api.example.test",
  eventTitle: "Restored cloud competition",
  eventRegion: "us-east-1",
  mode: "backend",
};
export const teamKey = "k".repeat(43);
export const invitation = "i".repeat(43);
export const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const registrationBase = `/portal/registration/cloud-tenant/${eventId}`;
export const gateId = "cloud-gate-fixture";
export const nextId = "cloud-next-fixture";
export const teamRegion = "eu-west-1";
export const hintContent = "Inspect the deployed stack outputs in the team region.";
const consoleDestination = `https://${teamRegion}.console.aws.amazon.com/console/home?region=${teamRegion}`;
export const consoleUrl = `https://signin.aws.amazon.com/federation?Action=login&Destination=${encodeURIComponent(consoleDestination)}`;

function problem(problemId: string, jobId: string): ParticipantProblemView {
  return {
    problemId,
    jobId,
    region: teamRegion,
    awsAccountId: "111122223333",
    provider: "aws",
    accessCapabilities: ["console", "cli-credentials"],
    status: "COMPLETE",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    score: 0,
    stackOutputs: {},
    scoring: { kind: "flag", points: 100, flagSubmitted: false },
    deployLog: { cursor: "cloud-ready", entries: [] },
  };
}

export function createCloudNetwork() {
  let revealed = false;
  let solved = false;
  let teamName = "Cloud team";
  let teamNameSetByCompetitor = true;
  let receipt: string | undefined;
  const unexpected: string[] = [];
  const calls: { url: URL; method: string; init: RequestInit }[] = [];

  function teamView(): ParticipantTeamView {
    const hintPenalty = revealed ? 10 : 0;
    return {
      team: { teamId: "cloud-team", eventId, teamName, teamNameSetByCompetitor },
      problems: [
        {
          ...problem(gateId, "cloud-gate-job"),
          score: (solved ? 100 : 0) - hintPenalty,
          scoring: {
            kind: "flag",
            points: 100,
            flagSubmitted: solved,
            hints: [
              { id: "first", penalty: 10, revealed, ...(revealed ? { content: hintContent } : {}) },
            ],
          },
        },
        {
          ...problem(nextId, "cloud-next-job"),
          stackOutputs: solved ? { Endpoint: "https://challenge.example.test" } : {},
        },
      ],
      eventGate: { kind: "ok" },
      progression: {
        gateProblemId: gateId,
        gateCompleted: solved,
        policy: "required",
        completionBonus: 0,
        lockedProblemIds: solved ? [] : [nextId],
      },
    };
  }

  function route(url: URL, method: string, init: RequestInit): Response | undefined {
    switch (`${method} ${url.pathname}`) {
      case "GET /portal/me":
        return Response.json(teamView());
      case "PATCH /portal/me": {
        teamName = JSON.parse(String(init.body)).teamName;
        teamNameSetByCompetitor = true;
        return Response.json(teamView());
      }
      case "GET /portal/leaderboard": {
        return Response.json({
          eventId,
          entries: [
            {
              rank: 1,
              teamId: "cloud-team",
              teamName,
              score: 90,
              completedProblems: 1,
              totalProblems: 2,
              isMyTeam: true,
            },
          ],
        } satisfies LeaderboardResponse);
      }
      case "GET /portal/me/notifications": {
        return Response.json({
          eventId,
          items: [
            {
              notificationId: "cloud-notice",
              title: "Cloud event notice",
              body: "Use your assigned team region.",
              severity: "info",
              occurredAt: new Date().toISOString(),
            },
          ],
        } satisfies NotificationsResponse);
      }
      case "GET /portal/me/score-events": {
        return Response.json({
          entries: [
            {
              jobId: "cloud-gate-job",
              problemId: gateId,
              source: "hint",
              points: -10,
              result: "ok",
              occurredAt: new Date().toISOString(),
            },
          ],
        } satisfies ScoreEventsResponse);
      }
      case "GET /portal/leaderboard/score-events": {
        return Response.json({ eventId, teams: [] } satisfies LeaderboardScoreEventsResponse);
      }
      case `POST /portal/me/problems/${gateId}/hints/first/reveal`: {
        revealed = true;
        return Response.json({
          kind: "ok",
          content: hintContent,
          penaltyApplied: 10,
          totalScore: -10,
        });
      }
      case "POST /portal/me/submit-flag": {
        solved = true;
        return Response.json({ kind: "ok", scoreDelta: 100, totalScore: 90 });
      }
      case "GET /portal/me/console-signin-url": {
        return Response.json({ loginUrl: consoleUrl });
      }
      case "GET /portal/me/cli-credentials": {
        return Response.json({
          credentials: {
            accessKeyId: "SYNTHETIC_ACCESS_KEY",
            secretAccessKey: "synthetic-secret",
            sessionToken: "synthetic-session",
            expiration: new Date(Date.now() + 3600_000).toISOString(),
            region: teamRegion,
            awsAccountId: "111122223333",
          },
        });
      }
      default:
        return undefined;
    }
  }

  function registration(path: string, init: RequestInit): Response | undefined {
    const authorization = new Headers(init.headers).get("authorization");
    if (path === `${registrationBase}/info` && authorization === `Bearer ${invitation}`) {
      return Response.json({ name: cloudRuntime.eventTitle, state: "open", remaining: 2 });
    }
    if (path === `${registrationBase}/claim` && authorization === `Bearer ${invitation}`) {
      receipt = JSON.parse(String(init.body)).receipt;
      teamNameSetByCompetitor = false;
    } else if (path !== `${registrationBase}/status` || authorization !== `Bearer ${receipt}`) {
      return undefined;
    }
    return Response.json({
      eventName: cloudRuntime.eventTitle,
      teamId: "cloud-team",
      state: "ready",
      ready: 2,
      total: 2,
      teamLoginKey: teamKey,
    });
  }

  function apiResponse(url: URL, method: string, init: RequestInit): Response | undefined {
    if (method === "POST" && url.pathname.startsWith(registrationBase)) {
      return registration(url.pathname, init);
    }
    if (new Headers(init.headers).get("authorization") !== `Bearer ${teamKey}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return route(url, method, init);
  }

  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.origin);
    const method = init.method ?? "GET";
    calls.push({ url, method, init });
    if (url.pathname === "/runtime-config.json") return Response.json(cloudRuntime);
    let response: Response | undefined;
    if (url.origin === cloudRuntime.apiBaseUrl) response = apiResponse(url, method, init);
    if (response) return response;
    unexpected.push(`${method} ${url}`);
    throw new Error(`Unmocked cloud request: ${method} ${url}`);
  });
  return { fetcher, calls, unexpected };
}
