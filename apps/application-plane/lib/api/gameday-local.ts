import type { Attack, AttackLog, GameState, Team } from './gameday-types';

interface LocalGameDayState {
  games: Record<string, GameState>;
  teams: Record<string, Team[]>;
  logs: Record<string, AttackLog[]>;
  attacks: Record<string, Attack[]>;
  auditorRunning: boolean;
}

const DEFAULT_ATTACKS: Attack[] = [
  {
    id: 'atk-sqli',
    name: 'SQL Injection',
    slug: 'sql-injection',
    attackType: 'vulnerability',
    targetVulnerability: 'sql-injection',
    description: 'Database query injection attack',
    purchaseCost: 100,
    damage: 250,
    reward: 50,
    cooldownSeconds: 120,
    defenseHint: 'Use parameterized queries',
    hintCost: 25,
  },
  {
    id: 'atk-xss',
    name: 'Stored XSS',
    slug: 'stored-xss',
    attackType: 'vulnerability',
    targetVulnerability: 'stored-xss',
    description: 'Persistent client-side script injection',
    purchaseCost: 120,
    damage: 300,
    reward: 60,
    cooldownSeconds: 180,
    defenseHint: 'Escape untrusted output',
    hintCost: 30,
  },
];

function defaultGameState(eventId: string): GameState {
  return {
    eventId,
    tenantId: 'dev-tenant',
    isRunning: false,
    startedAt: null,
    scoreWeight: 'normal',
    blackout: false,
    durationMinutes: 60,
  };
}

function getStore(): LocalGameDayState {
  const root = globalThis as typeof globalThis & {
    __TENKACLOUD_LOCAL_GAMEDAY__?: LocalGameDayState;
  };
  if (!root.__TENKACLOUD_LOCAL_GAMEDAY__) {
    root.__TENKACLOUD_LOCAL_GAMEDAY__ = {
      games: {},
      teams: {},
      logs: {},
      attacks: {},
      auditorRunning: false,
    };
  }
  return root.__TENKACLOUD_LOCAL_GAMEDAY__;
}

export function isLocalGameDayEvent(eventId: string) {
  return eventId.startsWith('dev-event-');
}

export function getLocalGameState(eventId: string): GameState {
  const store = getStore();
  store.games[eventId] ??= defaultGameState(eventId);
  return store.games[eventId];
}

export function setLocalGameState(eventId: string, next: GameState) {
  getStore().games[eventId] = next;
  return next;
}

export function getLocalTeams(eventId: string): Team[] {
  const store = getStore();
  store.teams[eventId] ??= [];
  return store.teams[eventId];
}

export function setLocalTeams(eventId: string, teams: Team[]) {
  getStore().teams[eventId] = teams;
  return teams;
}

export function getLocalAttackLogs(eventId: string): AttackLog[] {
  const store = getStore();
  store.logs[eventId] ??= [];
  return store.logs[eventId];
}

export function pushLocalAttackLog(eventId: string, log: AttackLog) {
  getLocalAttackLogs(eventId).unshift(log);
  return log;
}

export function getLocalAttacks(eventId: string): Attack[] {
  const store = getStore();
  store.attacks[eventId] ??= [];
  return store.attacks[eventId];
}

export function seedLocalAttacks(eventId: string) {
  const seeded = DEFAULT_ATTACKS.map((attack) => ({
    ...attack,
    id: `${eventId}-${attack.id}`,
  }));
  getStore().attacks[eventId] = seeded;
  return seeded;
}

export function registerLocalTeam(
  eventId: string,
  teamId: string,
  teamName: string,
  urls?: { websiteUrl?: string; apiUrl?: string },
) {
  const teams = getLocalTeams(eventId);
  const existing = teams.find((team) => team.teamId === teamId);
  if (existing) {
    existing.teamName = teamName;
    existing.websiteUrl = urls?.websiteUrl;
    existing.apiUrl = urls?.apiUrl;
    return existing;
  }

  const created: Team = {
    eventId,
    teamId,
    teamName,
    websiteUrl: urls?.websiteUrl,
    apiUrl: urls?.apiUrl,
    score: 0,
  };
  teams.push(created);
  return created;
}

export function startLocalGame(eventId: string, durationMinutes?: number) {
  return setLocalGameState(eventId, {
    ...getLocalGameState(eventId),
    isRunning: true,
    startedAt: new Date().toISOString(),
    durationMinutes: durationMinutes || getLocalGameState(eventId).durationMinutes,
  });
}

export function stopLocalGame(eventId: string) {
  return setLocalGameState(eventId, {
    ...getLocalGameState(eventId),
    isRunning: false,
  });
}

export function toggleLocalScoreWeight(eventId: string) {
  const current = getLocalGameState(eventId);
  return setLocalGameState(eventId, {
    ...current,
    scoreWeight: current.scoreWeight === 'high' ? 'normal' : 'high',
  });
}

export function toggleLocalBlackout(eventId: string) {
  const current = getLocalGameState(eventId);
  return setLocalGameState(eventId, {
    ...current,
    blackout: !current.blackout,
  });
}

export function executeLocalFaultInjection(
  eventId: string,
  teamId: string,
  attackSlug: string,
) {
  const defender = getLocalTeams(eventId).find((team) => team.teamId === teamId);
  const attack = getLocalAttacks(eventId).find((item) => item.slug === attackSlug);
  const log: AttackLog = {
    id: `log-${Date.now()}`,
    eventId,
    attackerTeamId: 'admin',
    defenderTeamId: teamId,
    attackId: attack?.id || attackSlug,
    attackSlug,
    success: true,
    neutralized: false,
    damage: attack?.damage || 100,
    reward: attack?.reward || 0,
    details: `Admin fault injection against ${defender?.teamName || teamId}`,
    createdAt: new Date().toISOString(),
  };
  return pushLocalAttackLog(eventId, log);
}

export function setLocalAuditorRunning(running: boolean) {
  getStore().auditorRunning = running;
}

export function getLocalAuditorRunning() {
  return getStore().auditorRunning;
}
