/**
 * GameDay Admin API Client
 */

import { getAuthToken } from '@/lib/auth/get-auth-token';
import { getGamedayApiUrl } from '@/lib/api/backend-urls';
import type { AttackLog, GameState, Team } from './gameday-types';
import {
  executeLocalFaultInjection,
  getLocalAttackLogs,
  getLocalAuditorRunning,
  getLocalGameState,
  getLocalTeams,
  isLocalGameDayEvent,
  registerLocalTeam,
  seedLocalAttacks,
  setLocalAuditorRunning,
  startLocalGame,
  stopLocalGame,
  toggleLocalBlackout,
  toggleLocalScoreWeight,
} from './gameday-local';

const ADMIN_URL = `${getGamedayApiUrl()}/admin`;

interface FetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

async function adminRequest<T>(
  endpoint: string,
  options: FetchOptions = {},
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

async function withLocalFallback<T>(
  eventId: string,
  remote: () => Promise<T>,
  fallback: () => T,
): Promise<T> {
  try {
    return await remote();
  } catch (error) {
    if (isLocalGameDayEvent(eventId)) {
      console.warn('GameDay admin fallback to local store:', error);
      return fallback();
    }
    throw error;
  }
}

// --- Game Management ---

export function startGame(eventId: string, durationMinutes?: number) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<GameState>('/game/start', {
        method: 'POST',
        body: JSON.stringify({ eventId, durationMinutes }),
      }),
    () => startLocalGame(eventId, durationMinutes),
  );
}

export function stopGame(eventId: string) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<GameState>('/game/stop', {
        method: 'POST',
        body: JSON.stringify({ eventId }),
      }),
    () => stopLocalGame(eventId),
  );
}

export function getGameStatus(eventId: string) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<GameState>('/game/status', {
        params: { eventId },
      }),
    () => getLocalGameState(eventId),
  );
}

// --- Score & Features ---

export function toggleScoreWeight(eventId: string) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<GameState>('/score-weight/toggle', {
        method: 'POST',
        body: JSON.stringify({ eventId }),
      }),
    () => toggleLocalScoreWeight(eventId),
  );
}

export function toggleBlackout(eventId: string) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<GameState>('/blackout/toggle', {
        method: 'POST',
        body: JSON.stringify({ eventId }),
      }),
    () => toggleLocalBlackout(eventId),
  );
}

// --- Team Management ---

export function registerTeam(
  eventId: string,
  teamId: string,
  teamName: string,
  urls?: { websiteUrl?: string; apiUrl?: string },
) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<Team>('/teams/register', {
        method: 'POST',
        body: JSON.stringify({ eventId, teamId, teamName, ...urls }),
      }),
    () => registerLocalTeam(eventId, teamId, teamName, urls),
  );
}

export function getTeams(eventId: string) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<{ teams: Team[] }>('/teams', {
        params: { eventId },
      }),
    () => ({ teams: getLocalTeams(eventId) }),
  );
}

// --- Attack Catalog ---

export function seedAttacks(eventId: string) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<{ seeded: number }>('/attacks/seed', {
        method: 'POST',
        body: JSON.stringify({ eventId }),
      }),
    () => ({ seeded: seedLocalAttacks(eventId).length }),
  );
}

export function getAttackLogs(eventId: string) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<{ logs: AttackLog[] }>('/attack-logs', {
        params: { eventId },
      }),
    () => ({ logs: getLocalAttackLogs(eventId) }),
  );
}

// --- Fault Injection ---

export function executeFaultInjection(
  eventId: string,
  teamId: string,
  attackSlug: string,
) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<AttackLog>('/fault-injection/execute', {
        method: 'POST',
        body: JSON.stringify({ eventId, teamId, attackSlug }),
      }),
    () => executeLocalFaultInjection(eventId, teamId, attackSlug),
  );
}

// --- Auditor ---

export function startAuditor(eventId: string) {
  return withLocalFallback(
    eventId,
    () =>
      adminRequest<{ status: string; eventId: string }>('/auditor/start', {
        method: 'POST',
        body: JSON.stringify({ eventId }),
      }),
    () => {
      setLocalAuditorRunning(true);
      return { status: 'running', eventId };
    },
  );
}

export function stopAuditor() {
  return adminRequest<{ status: string }>('/auditor/stop', {
    method: 'POST',
  }).catch((error) => {
    if (getLocalAuditorRunning()) {
      console.warn('GameDay admin fallback to local auditor stop:', error);
      setLocalAuditorRunning(false);
      return { status: 'stopped' };
    }
    throw error;
  });
}
