/**
 * コンテスト管理機能
 *
 * 管理画面用：コンテスト（イベント）の開始/停止/管理
 * ※ 従来CLIで行っていた操作をAPI化
 */

import { PrismaClient } from '@prisma/client';
import { logContestStart, logContestEnd } from './eventlog';

const prisma = new PrismaClient();

/**
 * コンテストの状態
 */
export enum ContestStatus {
  DRAFT = 'draft',           // 下書き
  SCHEDULED = 'scheduled',   // 開始待ち
  RUNNING = 'running',       // 実行中
  PAUSED = 'paused',         // 一時停止
  ENDED = 'ended',           // 終了
}

/**
 * コンテスト情報
 */
export interface Contest {
  id: string;
  eventId: string;
  name: string;
  description: string;
  status: ContestStatus;
  startTime?: bigint;
  endTime?: bigint;
  duration: number; // 分
  maxTeams?: number;
  challenges: string[];
  createdAt: bigint;
  updatedAt: bigint;
}

/**
 * コンテストを作成
 */
export async function createContest(data: {
  eventId: string;
  name: string;
  description?: string;
  duration: number;
  maxTeams?: number;
  challengeIds?: string[];
}): Promise<Contest> {
  try {
    // 注意: Contest モデルはPrismaスキーマに追加が必要
    // 暫定的にEventLogを使ってコンテスト状態を管理
    const now = BigInt(Date.now());

    // コンテスト情報を返す（実際のDB保存は別途Contestモデル追加後）
    return {
      id: `contest-${data.eventId}`,
      eventId: data.eventId,
      name: data.name,
      description: data.description || '',
      status: ContestStatus.DRAFT,
      duration: data.duration,
      maxTeams: data.maxTeams,
      challenges: data.challengeIds || [],
      createdAt: now,
      updatedAt: now,
    };
  } catch (error) {
    console.error('Create contest error:', error);
    throw error;
  }
}

/**
 * コンテストを開始
 */
export async function startContest(
  eventId: string,
  contestName: string
): Promise<{
  success: boolean;
  message: string;
  startTime?: bigint;
}> {
  try {
    const now = BigInt(Date.now());

    // すべてのチャレンジを有効化（必要に応じて）
    // 実際にはChallenge.enabledフラグなどを更新

    // イベントログに開始を記録
    await logContestStart(eventId, contestName);

    return {
      success: true,
      message: `Contest "${contestName}" started successfully`,
      startTime: now,
    };
  } catch (error) {
    console.error('Start contest error:', error);
    return {
      success: false,
      message: String(error),
    };
  }
}

/**
 * コンテストを停止
 */
export async function stopContest(
  eventId: string,
  contestName: string
): Promise<{
  success: boolean;
  message: string;
  endTime?: bigint;
  finalLeaderboard?: Array<{
    rank: number;
    teamName: string;
    score: number;
  }>;
}> {
  try {
    const now = BigInt(Date.now());

    // すべてのアクティブなロックを解除
    await prisma.teamChallengeAnswer.updateMany({
      where: {
        challenge: { eventId },
        pessimisticLocking: true,
      },
      data: {
        pessimisticLocking: false,
      },
    });

    // 最終リーダーボードを取得
    const teamScores = await prisma.teamChallengeAnswer.groupBy({
      by: ['teamId'],
      where: {
        challenge: { eventId },
      },
      _sum: {
        score: true,
      },
    });

    const teamIds = teamScores.map((ts) => ts.teamId);
    const teams = await prisma.team.findMany({
      where: { id: { in: teamIds } },
    });
    const teamMap = new Map(teams.map((t) => [t.id, t]));

    const leaderboard = teamScores
      .map((ts) => ({
        teamId: ts.teamId,
        teamName: teamMap.get(ts.teamId)?.teamName || 'Unknown',
        score: ts._sum.score || 0,
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry, index) => ({
        rank: index + 1,
        teamName: entry.teamName,
        score: entry.score,
      }));

    // イベントログに終了を記録
    await logContestEnd(eventId, contestName);

    return {
      success: true,
      message: `Contest "${contestName}" ended successfully`,
      endTime: now,
      finalLeaderboard: leaderboard,
    };
  } catch (error) {
    console.error('Stop contest error:', error);
    return {
      success: false,
      message: String(error),
    };
  }
}

/**
 * コンテストを一時停止
 */
export async function pauseContest(
  _eventId: string
): Promise<{ success: boolean; message: string }> {
  // TODO: 実行中の検証をすべて一時停止
  // TODO: 新規回答の受付を停止するフラグを設定

  return {
    success: true,
    message: 'Contest paused',
  };
}

/**
 * コンテストを再開
 */
export async function resumeContest(
  _eventId: string
): Promise<{ success: boolean; message: string }> {
  // TODO: 一時停止を解除

  return {
    success: true,
    message: 'Contest resumed',
  };
}

/**
 * コンテストに問題を追加
 */
export async function addChallengeToContest(
  eventId: string,
  challengeData: {
    problemId: string;
    challengeId: string;
    title: string;
    category: string;
    difficulty: string;
    description: string;
    region?: string;
    sshKeyPairRequired?: boolean;
    tasks: Array<{
      titleId: string;
      title: string;
      content: string;
      taskNumber: number;
      answerKey: string;
      clues?: Array<{
        title: string;
        description: string;
        order: number;
      }>;
      scoring: {
        pointsPossible: number;
        clue1PenaltyPoints?: number;
        clue2PenaltyPoints?: number;
        clue3PenaltyPoints?: number;
      };
    }>;
  }
): Promise<{ success: boolean; challengeDbId?: string; message?: string }> {
  try {
    // トランザクションでチャレンジとタスクを作成
    const result = await prisma.$transaction(async (tx) => {
      // 1. チャレンジを作成
      const challenge = await tx.challenge.create({
        data: {
          eventId,
          problemId: challengeData.problemId,
          challengeId: challengeData.challengeId,
          title: challengeData.title,
          category: challengeData.category,
          difficulty: challengeData.difficulty,
          description: challengeData.description,
          region: challengeData.region,
          sshKeyPairRequired: challengeData.sshKeyPairRequired || false,
        },
      });

      // 2. タスクとクルーを作成
      for (const taskData of challengeData.tasks) {
        const task = await tx.task.create({
          data: {
            challengeId: challenge.id,
            titleId: taskData.titleId,
            title: taskData.title,
            content: taskData.content,
            taskNumber: taskData.taskNumber,
          },
        });

        // クルーを作成
        if (taskData.clues) {
          for (const clueData of taskData.clues) {
            await tx.clue.create({
              data: {
                taskId: task.id,
                title: clueData.title,
                description: clueData.description,
                order: clueData.order,
                taskNumber: taskData.taskNumber,
              },
            });
          }
        }

        // 回答を作成
        await tx.answer.create({
          data: {
            challengeId: challenge.id,
            taskId: task.id,
            titleId: taskData.titleId,
            answerKey: taskData.answerKey,
          },
        });

        // タスク採点設定を作成
        await tx.taskScoring.create({
          data: {
            challengeId: challenge.id,
            titleId: taskData.titleId,
            taskNumber: taskData.taskNumber,
            pointsPossible: taskData.scoring.pointsPossible,
            clue1PenaltyPoints: taskData.scoring.clue1PenaltyPoints || 0,
            clue2PenaltyPoints: taskData.scoring.clue2PenaltyPoints || 0,
            clue3PenaltyPoints: taskData.scoring.clue3PenaltyPoints || 0,
          },
        });
      }

      // 3. チャレンジ統計を初期化
      await tx.challengeStatistics.create({
        data: {
          challengeId: challenge.id,
          title: challenge.title,
        },
      });

      return challenge;
    });

    return {
      success: true,
      challengeDbId: result.id,
    };
  } catch (error) {
    console.error('Add challenge to contest error:', error);
    return {
      success: false,
      message: String(error),
    };
  }
}

/**
 * コンテストから問題を削除
 */
export async function removeChallengeFromContest(
  eventId: string,
  challengeId: string
): Promise<{ success: boolean; message?: string }> {
  try {
    // チャレンジを検索
    const challenge = await prisma.challenge.findFirst({
      where: { eventId, challengeId },
    });

    if (!challenge) {
      return {
        success: false,
        message: 'Challenge not found',
      };
    }

    // カスケード削除（関連するタスク、クルー、回答、統計も削除）
    await prisma.challenge.delete({
      where: { id: challenge.id },
    });

    return { success: true };
  } catch (error) {
    console.error('Remove challenge from contest error:', error);
    return {
      success: false,
      message: String(error),
    };
  }
}

/**
 * チームをコンテストに登録
 */
export async function registerTeamToContest(
  eventId: string,
  teamData: {
    teamName: string;
    members?: string[];
  }
): Promise<{ success: boolean; teamId?: string; message?: string }> {
  try {
    // チームを作成
    const team = await prisma.team.create({
      data: {
        eventId,
        teamName: teamData.teamName,
      },
    });

    // イベントの全チャレンジに対してタスク進捗を初期化
    const challenges = await prisma.challenge.findMany({
      where: { eventId },
      include: {
        tasks: true,
        taskScorings: true,
      },
    });

    for (const challenge of challenges) {
      // TeamChallengeAnswerを初期化
      await prisma.teamChallengeAnswer.create({
        data: {
          teamId: team.id,
          challengeId: challenge.id,
        },
      });

      // 各タスクの進捗を初期化
      for (const task of challenge.tasks) {
        const scoring = challenge.taskScorings.find(
          (ts) => ts.titleId === task.titleId
        );

        await prisma.taskProgress.create({
          data: {
            teamId: team.id,
            taskId: task.titleId,
            locked: task.taskNumber !== 1, // 最初のタスクだけアンロック
            pointsPossible: scoring?.pointsPossible || 0,
          },
        });
      }
    }

    return {
      success: true,
      teamId: team.id,
    };
  } catch (error) {
    console.error('Register team to contest error:', error);
    return {
      success: false,
      message: String(error),
    };
  }
}

/**
 * コンテストの参加チーム一覧を取得
 */
export async function getContestTeams(eventId: string): Promise<
  Array<{
    teamId: string;
    teamName: string;
    score: number;
    startedChallenges: number;
    completedChallenges: number;
  }>
> {
  try {
    // イベントに参加しているチームを取得
    const teamAnswers = await prisma.teamChallengeAnswer.findMany({
      where: {
        challenge: { eventId },
      },
      include: {
        team: true,
      },
    });

    // チームごとに集計
    const teamStats = new Map<
      string,
      {
        teamId: string;
        teamName: string;
        score: number;
        startedChallenges: number;
        completedChallenges: number;
      }
    >();

    for (const answer of teamAnswers) {
      const existing = teamStats.get(answer.teamId) || {
        teamId: answer.teamId,
        teamName: answer.team.teamName,
        score: 0,
        startedChallenges: 0,
        completedChallenges: 0,
      };

      existing.score += answer.score;
      if (answer.started) existing.startedChallenges++;
      if (answer.completed) existing.completedChallenges++;

      teamStats.set(answer.teamId, existing);
    }

    return Array.from(teamStats.values());
  } catch (error) {
    console.error('Get contest teams error:', error);
    throw error;
  }
}

export { prisma };
