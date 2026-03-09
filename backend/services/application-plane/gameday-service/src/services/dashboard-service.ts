import { gamedayRepository } from '../lib/dynamodb';
import { TeamAlreadyExistsError } from '../repositories/gameday-repository';
import type { TeamState } from '../repositories/gameday-repository';
import type { AttackLog, HealthCheckResult } from '../types';

export { TeamAlreadyExistsError };

export class BlackoutActiveError extends Error {
  constructor() {
    super('ブラックアウト中はリーダーボードを閲覧できません');
    this.name = 'BlackoutActiveError';
  }
}

// === チーム登録 ===

export async function registerTeam(input: {
  eventId: string;
  teamId: string;
  teamName: string;
  websiteUrl?: string;
  apiUrl?: string;
}): Promise<TeamState> {
  return gamedayRepository.createTeam(input);
}

// === チーム URL 更新 ===

export async function updateTeamUrl(
  eventId: string,
  teamId: string,
  urls: { websiteUrl?: string; apiUrl?: string }
): Promise<void> {
  const team = await gamedayRepository.getTeamState(eventId, teamId);
  if (!team) {
    throw new TeamNotFoundError(teamId);
  }
  await gamedayRepository.updateTeamUrls(eventId, teamId, urls);
}

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`チームが見つかりません: ${teamId}`);
    this.name = 'TeamNotFoundError';
  }
}

// === リーダーボード ===

export async function getLeaderboard(eventId: string): Promise<TeamState[]> {
  const game = await gamedayRepository.getGameState(eventId);
  if (game?.blackout) {
    throw new BlackoutActiveError();
  }

  const teams = await gamedayRepository.listTeams(eventId);
  return teams.sort((a, b) => b.score - a.score);
}

// === 攻撃統計 ===

export interface AttackStatistics {
  teamId: string;
  teamName: string;
  attacksSent: number;
  attacksReceived: number;
  successRate: number;
}

export async function getAttackStatistics(
  eventId: string
): Promise<AttackStatistics[]> {
  const [teams, logs] = await Promise.all([
    gamedayRepository.listTeams(eventId),
    gamedayRepository.listAttackLogs(eventId),
  ]);

  const statsMap = new Map<
    string,
    { sent: number; received: number; successSent: number }
  >();

  for (const team of teams) {
    statsMap.set(team.teamId, { sent: 0, received: 0, successSent: 0 });
  }

  for (const log of logs) {
    if (log.attackerTeamId === 'ADMIN') continue;

    const attackerStats = statsMap.get(log.attackerTeamId);
    if (attackerStats) {
      attackerStats.sent++;
      if (log.success) {
        attackerStats.successSent++;
      }
    }

    const defenderStats = statsMap.get(log.defenderTeamId);
    if (defenderStats) {
      defenderStats.received++;
    }
  }

  return teams.map((team) => {
    const stats = statsMap.get(team.teamId)!;
    return {
      teamId: team.teamId,
      teamName: team.teamName,
      attacksSent: stats.sent,
      attacksReceived: stats.received,
      successRate: stats.sent > 0 ? stats.successSent / stats.sent : 0,
    };
  });
}

// === チームダッシュボード ===

export interface TeamDashboard {
  team: TeamState;
  recentHealthChecks: HealthCheckResult[];
  attackHistory: AttackLog[];
}

export async function getTeamDashboard(
  eventId: string,
  teamId: string
): Promise<TeamDashboard | null> {
  const team = await gamedayRepository.getTeamState(eventId, teamId);
  if (!team) {
    return null;
  }

  const [recentHealthChecks, allLogs] = await Promise.all([
    gamedayRepository.listHealthChecks(eventId, teamId),
    gamedayRepository.listAttackLogs(eventId),
  ]);

  const attackHistory = allLogs.filter(
    (log) => log.attackerTeamId === teamId || log.defenderTeamId === teamId
  );

  return {
    team,
    recentHealthChecks,
    attackHistory,
  };
}
