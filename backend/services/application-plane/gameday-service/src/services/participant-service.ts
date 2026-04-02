import { gamedayRepository } from '../lib/dynamodb';
import {
  AttackAlreadyPurchasedError,
  VoteAlreadyExistsError,
} from '../repositories/gameday-repository';
import type {
  Attack,
  AttackPurchase,
  AttackLog,
  TeamVulnerability,
  Alliance,
  HealthCheckResult,
  Vote,
} from '../types';

export { AttackAlreadyPurchasedError, VoteAlreadyExistsError };

// === 定数 ===
export const VOTE_BONUS_POINTS = 5000;

export class GameNotRunningError extends Error {
  constructor() {
    super('ゲームが開始されていません');
    this.name = 'GameNotRunningError';
  }
}

export class AttackNotFoundError extends Error {
  constructor(attackId: string) {
    super(`攻撃が見つかりません: ${attackId}`);
    this.name = 'AttackNotFoundError';
  }
}

export class AttackNotPurchasedError extends Error {
  constructor() {
    super('この攻撃は購入されていません');
    this.name = 'AttackNotPurchasedError';
  }
}

export class CooldownActiveError extends Error {
  remainingSeconds: number;
  constructor(remainingSeconds: number) {
    super(`クールダウン中です（残り${remainingSeconds}秒）`);
    this.name = 'CooldownActiveError';
    this.remainingSeconds = remainingSeconds;
  }
}

export class SelfAttackError extends Error {
  constructor() {
    super('自チームへの攻撃はできません');
    this.name = 'SelfAttackError';
  }
}

export class InsufficientScoreError extends Error {
  constructor() {
    super('スコアが不足しています');
    this.name = 'InsufficientScoreError';
  }
}

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`チームが見つかりません: ${teamId}`);
    this.name = 'TeamNotFoundError';
  }
}

export class AllianceNotFoundError extends Error {
  constructor(allianceId: string) {
    super(`同盟が見つかりません: ${allianceId}`);
    this.name = 'AllianceNotFoundError';
  }
}

export class AllianceUnauthorizedError extends Error {
  constructor() {
    super('この同盟を操作する権限がありません');
    this.name = 'AllianceUnauthorizedError';
  }
}

export class SelfVoteError extends Error {
  constructor() {
    super('自チームへの投票はできません');
    this.name = 'SelfVoteError';
  }
}

async function ensureGameRunning(eventId: string): Promise<void> {
  const game = await gamedayRepository.getGameState(eventId);
  if (!game || !game.isRunning) {
    throw new GameNotRunningError();
  }
}

// === 攻撃 ===

export async function getAttackCatalog(eventId: string): Promise<Attack[]> {
  return gamedayRepository.listAttackCatalog(eventId);
}

export async function purchaseAttack(
  eventId: string,
  teamId: string,
  attackId: string
): Promise<AttackPurchase> {
  await ensureGameRunning(eventId);

  const attack = await gamedayRepository.getAttack(eventId, attackId);
  if (!attack) {
    throw new AttackNotFoundError(attackId);
  }

  const team = await gamedayRepository.getTeamState(eventId, teamId);
  if (!team) {
    throw new TeamNotFoundError(teamId);
  }

  if (team.score < attack.purchaseCost) {
    throw new InsufficientScoreError();
  }

  const purchase = await gamedayRepository.createAttackPurchase({
    eventId,
    teamId,
    attackId: attack.id,
    attackSlug: attack.slug,
  });

  await gamedayRepository.updateTeamScore(
    eventId,
    teamId,
    -attack.purchaseCost
  );

  return purchase;
}

export async function executeAttack(
  eventId: string,
  attackerTeamId: string,
  defenderTeamId: string,
  attackId: string
): Promise<AttackLog> {
  await ensureGameRunning(eventId);

  if (attackerTeamId === defenderTeamId) {
    throw new SelfAttackError();
  }

  const attack = await gamedayRepository.getAttack(eventId, attackId);
  if (!attack) {
    throw new AttackNotFoundError(attackId);
  }

  const purchase = await gamedayRepository.getAttackPurchase(
    eventId,
    attackerTeamId,
    attack.slug
  );
  if (!purchase) {
    throw new AttackNotPurchasedError();
  }

  // クールダウンチェック
  if (purchase.lastUsedAt) {
    const lastUsed = new Date(purchase.lastUsedAt).getTime();
    const now = Date.now();
    const elapsed = (now - lastUsed) / 1000;
    if (elapsed < attack.cooldownSeconds) {
      throw new CooldownActiveError(
        Math.ceil(attack.cooldownSeconds - elapsed)
      );
    }
  }

  const defender = await gamedayRepository.getTeamState(
    eventId,
    defenderTeamId
  );
  if (!defender) {
    throw new TeamNotFoundError(defenderTeamId);
  }

  // 脆弱性悪用型の場合、被害者が修正済みかチェック
  let success = true;
  if (attack.attackType === 'vulnerability' && attack.targetVulnerability) {
    const vuln = await gamedayRepository.getTeamVulnerability(
      eventId,
      defenderTeamId,
      attack.targetVulnerability
    );
    if (vuln && vuln.isFixed) {
      success = false;
    }
  }

  const now = new Date().toISOString();
  await gamedayRepository.updatePurchaseLastUsedAt(
    eventId,
    attackerTeamId,
    attack.slug,
    now
  );

  if (success) {
    // 同盟報酬分配
    const alliances = await gamedayRepository.listTeamActiveAlliances(
      eventId,
      attackerTeamId
    );
    const activeAllyTeamIds = alliances.map((a) =>
      a.requesterTeamId === attackerTeamId ? a.targetTeamId : a.requesterTeamId
    );

    const totalMembers = 1 + activeAllyTeamIds.length;
    const sharePerMember = Math.floor(attack.reward / totalMembers);
    const remainder = attack.reward - sharePerMember * totalMembers;

    // 全スコア変更を原子的に実行
    const scoreUpdates: Array<{ teamId: string; delta: number }> = [
      { teamId: defenderTeamId, delta: -attack.damage },
      { teamId: attackerTeamId, delta: sharePerMember + remainder },
    ];
    for (const allyTeamId of activeAllyTeamIds) {
      scoreUpdates.push({ teamId: allyTeamId, delta: sharePerMember });
    }
    await gamedayRepository.updateMultipleTeamScores(eventId, scoreUpdates);

    return gamedayRepository.addAttackLog({
      eventId,
      attackerTeamId,
      defenderTeamId,
      attackId: attack.id,
      attackSlug: attack.slug,
      success: true,
      damage: attack.damage,
      reward: sharePerMember + remainder,
      details: `${attack.name} 攻撃成功`,
    });
  } else {
    // ブロック成功: 被害者に報酬
    await gamedayRepository.updateTeamScore(
      eventId,
      defenderTeamId,
      attack.reward
    );

    return gamedayRepository.addAttackLog({
      eventId,
      attackerTeamId,
      defenderTeamId,
      attackId: attack.id,
      attackSlug: attack.slug,
      success: false,
      damage: 0,
      reward: 0,
      details: `${attack.name} 攻撃が防御されました`,
    });
  }
}

export async function getAllAttackLogs(eventId: string): Promise<AttackLog[]> {
  return gamedayRepository.listAttackLogs(eventId);
}

export async function getAttackHistory(
  eventId: string,
  teamId: string
): Promise<AttackLog[]> {
  const logs = await gamedayRepository.listAttackLogs(eventId);
  return logs.filter((log) => log.attackerTeamId === teamId);
}

export async function getActiveAttacks(
  eventId: string,
  teamId: string
): Promise<AttackLog[]> {
  const logs = await gamedayRepository.listAttackLogs(eventId);
  return logs.filter(
    (log) => log.defenderTeamId === teamId && log.success && !log.neutralized
  );
}

// === 防御 ===

export async function purchaseHint(
  eventId: string,
  teamId: string,
  attackId: string
): Promise<{ hint: string; cost: number }> {
  await ensureGameRunning(eventId);

  const attack = await gamedayRepository.getAttack(eventId, attackId);
  if (!attack) {
    throw new AttackNotFoundError(attackId);
  }

  if (attack.hintCost > 0) {
    const team = await gamedayRepository.getTeamState(eventId, teamId);
    if (!team) {
      throw new TeamNotFoundError(teamId);
    }
    if (team.score < attack.hintCost) {
      throw new InsufficientScoreError();
    }
    await gamedayRepository.updateTeamScore(eventId, teamId, -attack.hintCost);
  }

  return { hint: attack.defenseHint, cost: attack.hintCost };
}

export async function reportFix(
  eventId: string,
  teamId: string,
  vulnerabilitySlug: string
): Promise<TeamVulnerability> {
  await ensureGameRunning(eventId);

  return gamedayRepository.upsertTeamVulnerability({
    eventId,
    teamId,
    vulnerabilitySlug,
    isFixed: true,
  });
}

// === 同盟 ===

export async function listTeamAlliances(
  eventId: string,
  teamId: string
): Promise<Alliance[]> {
  const alliances = await gamedayRepository.listAlliances(eventId);
  return alliances.filter(
    (a) => a.requesterTeamId === teamId || a.targetTeamId === teamId
  );
}

export async function requestAlliance(
  eventId: string,
  requesterTeamId: string,
  targetTeamId: string
): Promise<Alliance> {
  await ensureGameRunning(eventId);

  return gamedayRepository.createAlliance({
    eventId,
    requesterTeamId,
    targetTeamId,
  });
}

export async function acceptAlliance(
  eventId: string,
  allianceId: string,
  teamId: string
): Promise<Alliance> {
  await ensureGameRunning(eventId);

  const alliance = await gamedayRepository.getAlliance(eventId, allianceId);
  if (!alliance) {
    throw new AllianceNotFoundError(allianceId);
  }

  if (alliance.targetTeamId !== teamId) {
    throw new AllianceUnauthorizedError();
  }

  await gamedayRepository.updateAllianceStatus(eventId, allianceId, 'ACTIVE');

  return { ...alliance, status: 'ACTIVE', updatedAt: new Date().toISOString() };
}

export async function breakAlliance(
  eventId: string,
  allianceId: string,
  teamId: string
): Promise<void> {
  await ensureGameRunning(eventId);

  const alliance = await gamedayRepository.getAlliance(eventId, allianceId);
  if (!alliance) {
    throw new AllianceNotFoundError(allianceId);
  }

  if (alliance.requesterTeamId !== teamId && alliance.targetTeamId !== teamId) {
    throw new AllianceUnauthorizedError();
  }

  await gamedayRepository.deleteAlliance(eventId, allianceId);
}

// === モニタリング ===

export async function getMonitoringStatus(
  eventId: string,
  teamId: string
): Promise<HealthCheckResult[]> {
  return gamedayRepository.listHealthChecks(eventId, teamId);
}

// === 投票 ===

export async function castVote(
  eventId: string,
  voterTeamId: string,
  votedForTeamId: string
): Promise<Vote> {
  if (voterTeamId === votedForTeamId) {
    throw new SelfVoteError();
  }

  const vote = await gamedayRepository.castVote({
    eventId,
    voterTeamId,
    votedForTeamId,
  });

  // 投票ボーナス
  await gamedayRepository.updateTeamScore(
    eventId,
    votedForTeamId,
    VOTE_BONUS_POINTS
  );

  return vote;
}

export async function getVotingResults(
  eventId: string
): Promise<{ teamId: string; votes: number }[]> {
  const votes = await gamedayRepository.listVotes(eventId);

  const counts: Record<string, number> = {};
  for (const vote of votes) {
    counts[vote.votedForTeamId] = (counts[vote.votedForTeamId] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([teamId, voteCount]) => ({ teamId, votes: voteCount }))
    .sort((a, b) => b.votes - a.votes);
}
