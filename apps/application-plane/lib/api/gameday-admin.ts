/**
 * GameDay Admin API Client
 */

import { getSession } from 'next-auth/react';
import type { AttackLog, GameState, Team } from './gameday-types';

const GAMEDAY_API_URL =
  process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
  'http://localhost:3020/api/gameday';

const ADMIN_URL = `${GAMEDAY_API_URL}/admin`;

interface FetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

async function getAuthToken(): Promise<string | null> {
  const session = await getSession();
  return session?.accessToken ?? null;
}

async function adminRequest<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { params, ...fetchOptions } = options;

  let url = `${ADMIN_URL}${endpoint}`;
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
    (err as Error & { status: number }).status = response.status;
    throw err;
  }

  return response.json();
}

// --- Game Management ---

export function startGame(eventId: string, durationMinutes?: number) {
  return adminRequest<GameState>('/game/start', {
    method: 'POST',
    body: JSON.stringify({ eventId, durationMinutes }),
  });
}

export function stopGame(eventId: string) {
  return adminRequest<GameState>('/game/stop', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
}

export function getGameStatus(eventId: string) {
  return adminRequest<GameState>('/game/status', {
    params: { eventId },
  });
}

// --- Score & Features ---

export function toggleScoreWeight(eventId: string) {
  return adminRequest<GameState>('/score-weight/toggle', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
}

export function toggleBlackout(eventId: string) {
  return adminRequest<GameState>('/blackout/toggle', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
}

// --- Team Management ---

export function registerTeam(
  eventId: string,
  teamId: string,
  teamName: string,
  urls?: { websiteUrl?: string; apiUrl?: string }
) {
  return adminRequest<Team>('/teams/register', {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId, teamName, ...urls }),
  });
}

export function getTeams(eventId: string) {
  return adminRequest<{ teams: Team[] }>('/teams', {
    params: { eventId },
  });
}

// --- Attack Catalog ---

export function seedAttacks(eventId: string) {
  return adminRequest<{ seeded: number }>('/attacks/seed', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
}

export function getAttackLogs(eventId: string) {
  return adminRequest<{ logs: AttackLog[] }>('/attack-logs', {
    params: { eventId },
  });
}

// --- Fault Injection ---

export function executeFaultInjection(
  eventId: string,
  teamId: string,
  attackSlug: string
) {
  return adminRequest<AttackLog>('/fault-injection/execute', {
    method: 'POST',
    body: JSON.stringify({ eventId, teamId, attackSlug }),
  });
}

// --- Auditor ---

export function startAuditor(eventId: string) {
  return adminRequest<{ status: string; eventId: string }>('/auditor/start', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
}

export function stopAuditor() {
  return adminRequest<{ status: string }>('/auditor/stop', {
    method: 'POST',
  });
}
