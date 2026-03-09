import { gamedayRepository } from '../lib/dynamodb';
import { ConcurrentModificationError } from '../repositories/gameday-repository';
import type { GameState, AttackLog } from '../types';
import type { TeamState } from '../repositories/gameday-repository';

export { ConcurrentModificationError };

export class GameNotFoundError extends Error {
  constructor() {
    super('ゲームが見つかりません');
    this.name = 'GameNotFoundError';
  }
}

export async function startGame(
  eventId: string,
  tenantId: string,
  durationMinutes: number
): Promise<GameState> {
  return gamedayRepository.createGameState({
    eventId,
    tenantId,
    durationMinutes,
  });
}

export async function stopGame(eventId: string): Promise<GameState> {
  const result = await gamedayRepository.stopGame(eventId);
  if (!result) {
    throw new GameNotFoundError();
  }
  return result;
}

export async function getGameStatus(
  eventId: string
): Promise<GameState | null> {
  return gamedayRepository.getGameState(eventId);
}

export async function toggleScoreWeight(eventId: string): Promise<GameState> {
  const result = await gamedayRepository.toggleScoreWeight(eventId);
  if (!result) {
    throw new GameNotFoundError();
  }
  return result;
}

export async function toggleBlackout(eventId: string): Promise<GameState> {
  const result = await gamedayRepository.toggleBlackout(eventId);
  if (!result) {
    throw new GameNotFoundError();
  }
  return result;
}

export async function executeFaultInjection(
  eventId: string,
  teamId: string,
  attackSlug: string
): Promise<AttackLog> {
  return gamedayRepository.addAttackLog({
    eventId,
    attackerTeamId: 'ADMIN',
    defenderTeamId: teamId,
    attackId: attackSlug,
    attackSlug,
    success: true,
    damage: 0,
    reward: 0,
    details: `管理者による障害注入: ${attackSlug}`,
  });
}

export async function listTeams(eventId: string): Promise<TeamState[]> {
  return gamedayRepository.listTeams(eventId);
}

export async function listAttackLogs(eventId: string): Promise<AttackLog[]> {
  return gamedayRepository.listAttackLogs(eventId);
}
