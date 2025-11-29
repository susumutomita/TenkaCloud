/**
 * クルーペナルティ採点ロジック
 *
 * minoru1/RestApp/LambdaFunction/Clue の採点ロジックを TypeScript で再実装
 */

import { PrismaClient } from '@prisma/client';
import { withLock, withSerializableTransaction } from './locking';

const prisma = new PrismaClient();

/**
 * クルーペナルティの型
 */
interface CluePenalty {
  order: number;
  penalty: number;
}

/**
 * 使用済みクルーの型
 */
interface UsedClue {
  order: number;
  description: string;
}

/**
 * タスク進捗からポイント獲得を計算
 *
 * pointsEarned = pointsPossible - sum(cluePenalties)
 */
export async function calculatePointsEarned(
  teamId: string,
  taskId: string
): Promise<number> {
  const taskProgress = await prisma.taskProgress.findUnique({
    where: { teamId_taskId: { teamId, taskId } },
  });

  if (!taskProgress) {
    throw new Error(`TaskProgress not found: teamId=${teamId}, taskId=${taskId}`);
  }

  const cluePenalties = taskProgress.cluePenalties as unknown as CluePenalty[];
  const totalPenalty = cluePenalties.reduce((sum, p) => sum + p.penalty, 0);
  const pointsEarned = taskProgress.pointsPossible - totalPenalty;

  // 更新
  await prisma.taskProgress.update({
    where: { teamId_taskId: { teamId, taskId } },
    data: { pointsEarned },
  });

  return pointsEarned;
}

/**
 * クルーを開く処理
 *
 * minoru1/RestApp/LambdaFunction/Clue/clue.py の openClueQueries を再実装
 */
export async function openClue(
  eventId: string,
  teamId: string,
  challengeId: string,
  taskId: string,
  clueOrder: number
): Promise<{ success: boolean; message: string }> {
  return withSerializableTransaction(async (tx) => {
    // 1. タスク進捗を取得
    const taskProgress = await tx.taskProgress.findUnique({
      where: { teamId_taskId: { teamId, taskId } },
    });

    if (!taskProgress) {
      return { success: false, message: 'Task progress not found' };
    }

    // 2. チームチャレンジ回答を取得
    const teamChallengeAnswer = await tx.teamChallengeAnswer.findUnique({
      where: { teamId_challengeId: { teamId, challengeId } },
    });

    if (!teamChallengeAnswer) {
      return { success: false, message: 'Team challenge answer not found' };
    }

    // 3. 既に開かれているかチェック
    const usedClues = (taskProgress.usedClues || []) as unknown as UsedClue[];
    if (usedClues.length > clueOrder) {
      return { success: false, message: 'Clue already opened. Please reload.' };
    }

    // 4. チャレンジが開始済みで未完了かチェック
    if (teamChallengeAnswer.completed || !teamChallengeAnswer.started) {
      return { success: false, message: 'Challenge is not in progress' };
    }

    // 5. クルー情報を取得
    const clue = await tx.clue.findFirst({
      where: { taskId, order: clueOrder },
    });

    if (!clue) {
      return { success: false, message: 'Clue not found' };
    }

    // 6. タスク採点設定を取得
    const challenge = await tx.challenge.findFirst({
      where: { eventId, challengeId },
    });

    if (!challenge) {
      return { success: false, message: 'Challenge not found' };
    }

    const taskScoring = await tx.taskScoring.findFirst({
      where: { challengeId: challenge.id, titleId: taskId },
    });

    if (!taskScoring) {
      return { success: false, message: 'Task scoring not found' };
    }

    // 7. ペナルティポイントを計算
    const penaltyKey = `clue${clueOrder + 1}PenaltyPoints` as keyof typeof taskScoring;
    const penaltyPoints = (taskScoring[penaltyKey] as number) || 0;

    // 8. 使用済みクルーを更新
    const newUsedClue: UsedClue = {
      order: clueOrder,
      description: clue.description,
    };
    usedClues.push(newUsedClue);

    // 9. クルーペナルティを更新
    const cluePenalties = (taskProgress.cluePenalties || []) as unknown as CluePenalty[];
    const newPenalty: CluePenalty = {
      order: clueOrder,
      penalty: penaltyPoints,
    };
    cluePenalties.push(newPenalty);

    // 10. ポイント獲得を計算
    const totalPenalty = cluePenalties.reduce((sum, p) => sum + p.penalty, 0);
    const pointsEarned = taskProgress.pointsPossible - totalPenalty;

    // 11. タスク進捗を更新
    await tx.taskProgress.update({
      where: { teamId_taskId: { teamId, taskId } },
      data: {
        usedClues: usedClues as unknown as object[],
        cluePenalties: cluePenalties as unknown as object[],
        pointsEarned,
      },
    });

    // 12. チャレンジ統計を更新
    await tx.challengeStatistics.upsert({
      where: { challengeId: challenge.id },
      create: {
        challengeId: challenge.id,
        title: challenge.title,
        totalRequestedClue: 1,
        teamsRequestedClues: [teamId],
      },
      update: {
        totalRequestedClue: { increment: 1 },
        teamsRequestedClues: { push: teamId },
      },
    });

    // 13. チームの最大獲得可能スコアを更新
    const allTaskProgress = await tx.taskProgress.findMany({
      where: { teamId },
    });

    const maxPossibleEventScore = allTaskProgress.reduce(
      (sum, tp) => sum + tp.pointsEarned,
      0
    );

    await tx.teamLeaderboardEntry.updateMany({
      where: { eventId, teamId },
      data: { maxPossibleEventScore },
    });

    // 14. イベントログを追加
    const team = await tx.team.findUnique({ where: { id: teamId } });
    await tx.eventLog.create({
      data: {
        eventId,
        teamName: team?.teamName || '',
        message: `Requested ${challenge.title} Clue`,
        dateTimeUTC: BigInt(Date.now()),
      },
    });

    return { success: true, message: 'Clue opened successfully' };
  });
}

/**
 * 回答を検証する処理
 *
 * minoru1/RestApp/LambdaFunction/Validatekey の validatekey を再実装
 */
export async function validateAnswer(
  eventId: string,
  teamId: string,
  challengeId: string,
  taskId: string,
  answer: string
): Promise<{ success: boolean; correct: boolean; message: string }> {
  // ロック付きで処理
  const result = await withLock(teamId, challengeId, async () => {
    return withSerializableTransaction(async (tx) => {
      // 1. チームチャレンジ回答を取得
      const teamChallengeAnswer = await tx.teamChallengeAnswer.findUnique({
        where: { teamId_challengeId: { teamId, challengeId } },
      });

      if (!teamChallengeAnswer) {
        return { correct: false, message: 'Team challenge answer not found' };
      }

      // 2. タスク進捗を取得
      const taskProgress = await tx.taskProgress.findUnique({
        where: { teamId_taskId: { teamId, taskId } },
      });

      if (!taskProgress) {
        return { correct: false, message: 'Task progress not found' };
      }

      // 3. 検証条件チェック
      if (
        teamChallengeAnswer.completed ||
        !teamChallengeAnswer.started ||
        taskProgress.completed ||
        taskProgress.locked
      ) {
        return { correct: false, message: 'Task is not available for submission' };
      }

      // 4. チャレンジを取得
      const challenge = await tx.challenge.findFirst({
        where: { eventId, challengeId },
      });

      if (!challenge) {
        return { correct: false, message: 'Challenge not found' };
      }

      // 5. 正解を取得
      const correctAnswer = await tx.answer.findFirst({
        where: { challengeId: challenge.id, titleId: taskId },
      });

      if (!correctAnswer) {
        return { correct: false, message: 'Answer not found' };
      }

      // 6. 回答チェック
      if (correctAnswer.answerKey !== answer) {
        return { correct: false, message: 'Incorrect answer' };
      }

      // 7. 正解処理
      // タスク進捗を完了に更新
      await tx.taskProgress.update({
        where: { teamId_taskId: { teamId, taskId } },
        data: { completed: true },
      });

      // チームチャレンジ回答のスコアを更新
      const newScore = teamChallengeAnswer.score + taskProgress.pointsEarned;
      await tx.teamChallengeAnswer.update({
        where: { teamId_challengeId: { teamId, challengeId } },
        data: { score: newScore },
      });

      // リーダーボードを更新
      const timestamp = BigInt(Date.now());
      await tx.teamLeaderboardEntry.updateMany({
        where: { eventId, teamId },
        data: {
          teamTotalEffectiveScore: { increment: taskProgress.pointsEarned },
          timestamp,
        },
      });

      // リーダーボード履歴を追加
      const team = await tx.team.findUnique({ where: { id: teamId } });

      // 全チャレンジのスコアを合計
      const allAnswers = await tx.teamChallengeAnswer.findMany({
        where: { teamId },
      });
      const totalScore = allAnswers.reduce((sum, a) => sum + a.score, 0);

      await tx.leaderboardEntryHistory.create({
        data: {
          eventId,
          teamId,
          teamName: team?.teamName || '',
          teamTotalEffectiveScore: totalScore,
          timestamp,
          recordedAt: timestamp,
        },
      });

      // 8. 最後のタスクかチェック
      const taskScorings = await tx.taskScoring.findMany({
        where: { challengeId: challenge.id },
        orderBy: { taskNumber: 'asc' },
      });

      const currentTaskIndex = taskScorings.findIndex((ts) => ts.titleId === taskId);
      const isLastTask = currentTaskIndex === taskScorings.length - 1;

      if (isLastTask) {
        // チャレンジ完了
        await tx.teamChallengeAnswer.update({
          where: { teamId_challengeId: { teamId, challengeId } },
          data: { completed: true },
        });

        // 統計更新
        await tx.challengeStatistics.update({
          where: { challengeId: challenge.id },
          data: {
            totalCompletedChallenge: { increment: 1 },
            teamsCompletedChallenge: { push: team?.teamName || '' },
          },
        });

        // イベントログ
        await tx.eventLog.create({
          data: {
            eventId,
            teamName: team?.teamName || '',
            message: `Completed ${challenge.title}`,
            dateTimeUTC: timestamp,
          },
        });
      } else {
        // 次のタスクをアンロック
        const nextTaskScoring = taskScorings[currentTaskIndex + 1];
        if (nextTaskScoring) {
          await tx.taskProgress.updateMany({
            where: { teamId, taskId: nextTaskScoring.titleId },
            data: { locked: false },
          });
        }

        // イベントログ
        await tx.eventLog.create({
          data: {
            eventId,
            teamName: team?.teamName || '',
            message: `Break through the task of ${challenge.title}`,
            dateTimeUTC: timestamp,
          },
        });
      }

      return { correct: true, message: 'Answer correct!' };
    });
  });

  if (!result.success) {
    return { success: false, correct: false, message: result.error || 'Lock failed' };
  }

  return { success: true, ...result.result! };
}

export { prisma };
