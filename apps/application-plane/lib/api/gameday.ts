/**
 * GameDay Participant API Client
 */

import { getAuthToken } from '@/lib/auth/get-auth-token';
import type {
  Alliance,
  Attack,
  AttackLog,
  AttackPurchase,
  AttackStats,
  GameState,
  HealthCheckResult,
  LeaderboardEntry,
  Team,
  TeamDashboard,
  Vote,
} from './gameday-types';

const GAMEDAY_API_URL =
  process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
  'http://localhost:3020/api/gameday';

interface FetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

export async function gamedayRequest<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { params, ...fetchOptions } = options;

  let url = `${GAMEDAY_API_URL}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        searchParams.append(key, String(value));
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }

  const token = await getAuthToken();

  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...fetchOptions.headers,
    },
  });

  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: 'Unknown error' }));
    const err = new Error(body.error || `HTTP ${response.status}`);
    (err as Error & { status: number; body: unknown }).status = response.status;
    (err as Error & { body: unknown }).body = body;
    throw err;
  }

  return response.json();
}

// --- Attack ---

export function getAttackCatalog(eventId: string) {
  return gamedayRequest<{ attacks: Attack[] }>('/attacks/catalog', {
    params: { eventId },
  });
}

export function getParticipantTeams(eventId: string) {
  return gamedayRequest<{ teams: Team[] }>('/teams', {
    params: { eventId },
  });
}

export function getParticipantGameStatus(eventId: string) {
  return gamedayRequest<GameState>('/game/status', {
    params: { eventId },
  });
}

export function purchaseAttack(
  eventId: string,
  teamId: string,
  attackId: string
) {
  return gamedayRequest<AttackPurchase>('/attacks/purchase', {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId, attackId }),
  });
}

export function executeAttack(
  eventId: string,
  teamId: string,
  attackId: string,
  targetTeamId: string
) {
  return gamedayRequest<AttackLog>('/attacks/execute', {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId, attackId, targetTeamId }),
  });
}

export function getAttackHistory(eventId: string, teamId: string) {
  return gamedayRequest<{ history: AttackLog[] }>('/attacks/history', {
    params: { eventId, teamId },
  });
}

// --- Defense ---

export function getActiveDefense(eventId: string, teamId: string) {
  return gamedayRequest<{ attacks: AttackLog[] }>('/defense/active', {
    params: { eventId, teamId },
  });
}

export function purchaseHint(
  eventId: string,
  teamId: string,
  attackId: string
) {
  return gamedayRequest<{ hint: string; cost: number }>('/defense/hint', {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId, attackId }),
  });
}

export function reportFix(
  eventId: string,
  teamId: string,
  vulnerabilitySlug: string
) {
  return gamedayRequest<{ success: boolean; pointsAwarded: number }>(
    '/defense/report-fix',
    {
      method: 'POST',
      body: JSON.stringify({ eventId, teamId, vulnerabilitySlug }),
    }
  );
}

// --- Alliance ---

export function getAlliances(eventId: string, teamId: string) {
  return gamedayRequest<{ alliances: Alliance[] }>('/alliances', {
    params: { eventId, teamId },
  });
}

export function requestAlliance(
  eventId: string,
  teamId: string,
  targetTeamId: string
) {
  return gamedayRequest<Alliance>('/alliances/request', {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId, targetTeamId }),
  });
}

export function acceptAlliance(
  allianceId: string,
  eventId: string,
  teamId: string
) {
  return gamedayRequest<Alliance>(`/alliances/${allianceId}/accept`, {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId }),
  });
}

export function breakAlliance(
  allianceId: string,
  eventId: string,
  teamId: string
) {
  return gamedayRequest<{ success: boolean }>(
    `/alliances/${allianceId}/break`,
    {
      method: 'POST',
      body: JSON.stringify({ eventId, teamId }),
    }
  );
}

// --- Monitoring ---

export function getMonitoringStatus(eventId: string, teamId: string) {
  return gamedayRequest<{ checks: HealthCheckResult[] }>('/monitoring/status', {
    params: { eventId, teamId },
  });
}

// --- Voting ---

export function submitVote(
  eventId: string,
  teamId: string,
  votedForTeamId: string
) {
  return gamedayRequest<Vote>('/voting/vote', {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId, votedForTeamId }),
  });
}

export function getVotingResults(eventId: string) {
  return gamedayRequest<{ results: Vote[] }>('/voting/results', {
    params: { eventId },
  });
}

// --- Dashboard ---

export function getLeaderboard(eventId: string) {
  return gamedayRequest<{ leaderboard: LeaderboardEntry[] }>(
    '/dashboard/leaderboard',
    { params: { eventId } }
  );
}

export function getAttackStats(eventId: string) {
  return gamedayRequest<{ stats: AttackStats[] }>('/dashboard/attack-stats', {
    params: { eventId },
  });
}

export function getTeamDashboard(eventId: string, teamId: string) {
  return gamedayRequest<TeamDashboard>('/dashboard/team', {
    params: { eventId, teamId },
  });
}

// --- Team URL ---

export function updateTeamUrl(
  eventId: string,
  teamId: string,
  urls: { websiteUrl?: string; apiUrl?: string }
) {
  return gamedayRequest<{ success: boolean }>('/teams/update-url', {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId, ...urls }),
  });
}
