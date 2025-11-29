/**
 * Pessimistic Locking 機構
 *
 * minoru1/RestApp/LambdaFunction/Validatekey の lock/unlock パターンを
 * PostgreSQL トランザクションで再実装
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * ロック取得結果
 */
export interface LockResult {
  success: boolean;
  error?: string;
}

/**
 * TeamChallengeAnswer のロックを取得
 *
 * PostgreSQL の SELECT FOR UPDATE を使用した排他ロック
 */
export async function acquireLock(
  teamId: string,
  challengeId: string,
  maxRetries = 10,
  retryIntervalMs = 100
): Promise<LockResult> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // トランザクション内で排他ロックを試行
      const result = await prisma.$executeRaw`
        UPDATE team_challenge_answers
        SET pessimistic_locking = true
        WHERE team_id = ${teamId}
          AND challenge_id = ${challengeId}
          AND pessimistic_locking = false
      `;

      if (result > 0) {
        return { success: true };
      }

      // ロック取得失敗、リトライ前に待機
      await sleep(retryIntervalMs);
    } catch (error) {
      console.error('Lock acquisition error:', error);
      return { success: false, error: String(error) };
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}

/**
 * TeamChallengeAnswer のロックを解放
 */
export async function releaseLock(
  teamId: string,
  challengeId: string
): Promise<boolean> {
  try {
    await prisma.teamChallengeAnswer.update({
      where: {
        teamId_challengeId: { teamId, challengeId },
      },
      data: {
        pessimisticLocking: false,
      },
    });
    return true;
  } catch (error) {
    console.error('Lock release error:', error);
    return false;
  }
}

/**
 * ロック付きで処理を実行するラッパー
 */
export async function withLock<T>(
  teamId: string,
  challengeId: string,
  operation: () => Promise<T>
): Promise<{ success: boolean; result?: T; error?: string }> {
  // ロック取得
  const lockResult = await acquireLock(teamId, challengeId);
  if (!lockResult.success) {
    return {
      success: false,
      error: lockResult.error || 'Failed to acquire lock',
    };
  }

  try {
    // 処理実行
    const result = await operation();
    return { success: true, result };
  } catch (error) {
    return { success: false, error: String(error) };
  } finally {
    // 必ずロック解放
    await releaseLock(teamId, challengeId);
  }
}

/**
 * PostgreSQL トランザクションを使用した Serializable レベルのロック
 */
export async function withSerializableTransaction<T>(
  operation: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      return operation(tx as PrismaClient);
    },
    {
      isolationLevel: 'Serializable',
      timeout: 10000, // 10秒
    }
  );
}

/**
 * 指定ミリ秒待機
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { prisma };
