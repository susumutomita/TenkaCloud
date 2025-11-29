/**
 * チャレンジ管理
 *
 * minoru1/RestApp/LambdaFunction/StartChallenge を TypeScript で再実装
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * チャレンジを開始する
 *
 * minoru1/RestApp/LambdaFunction/StartChallenge/StartChallenge.py の startChallenge を再実装
 */
export async function startChallenge(
  eventId: string,
  teamId: string,
  challengeId: string,
  taskId: string
): Promise<{ success: boolean; message: string }> {
  try {
    // 1. チームを取得
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      return { success: false, message: 'Team not found' };
    }

    // 2. チャレンジを取得
    const challenge = await prisma.challenge.findFirst({
      where: { eventId, challengeId },
    });

    if (!challenge) {
      return { success: false, message: 'Challenge not found' };
    }

    // 3. 最初のタスクをアンロック
    await prisma.taskProgress.updateMany({
      where: { teamId, taskId },
      data: { locked: false },
    });

    // 4. チームチャレンジ回答を開始状態に更新
    await prisma.teamChallengeAnswer.upsert({
      where: { teamId_challengeId: { teamId, challengeId: challenge.id } },
      create: {
        teamId,
        challengeId: challenge.id,
        started: true,
      },
      update: {
        started: true,
      },
    });

    // 5. チャレンジ統計を更新
    await prisma.challengeStatistics.upsert({
      where: { challengeId: challenge.id },
      create: {
        challengeId: challenge.id,
        title: challenge.title,
        totalStartedChallenge: 1,
        teamsStartedChallenge: [team.teamName],
      },
      update: {
        totalStartedChallenge: { increment: 1 },
        teamsStartedChallenge: { push: team.teamName },
      },
    });

    // 6. イベントログを追加
    await prisma.eventLog.create({
      data: {
        eventId,
        teamName: team.teamName,
        message: `Start ${challenge.title}`,
        dateTimeUTC: BigInt(Date.now()),
      },
    });

    return { success: true, message: 'Challenge started successfully' };
  } catch (error) {
    console.error('Start challenge error:', error);
    return { success: false, message: String(error) };
  }
}

/**
 * チャレンジ一覧を取得（チーム視点）
 *
 * minoru1/RestApp/LambdaFunction/Load/load.py の一覧取得部分を再実装
 */
export async function getChallengesForTeam(
  eventId: string,
  teamId: string
): Promise<{
  success: boolean;
  challenges?: Array<{
    challengeId: string;
    title: string;
    category: string;
    difficulty: string;
    taskScoring: number;
    started: boolean;
    completed: boolean;
    score: number;
  }>;
  error?: string;
}> {
  try {
    // 1. イベント内のすべてのチャレンジを取得
    const challenges = await prisma.challenge.findMany({
      where: { eventId },
      include: {
        taskScorings: true,
        teamAnswers: {
          where: { teamId },
        },
      },
      orderBy: { challengeId: 'asc' },
    });

    const result = challenges.map((challenge) => {
      // タスク採点の合計ポイント
      const taskScoring = challenge.taskScorings.reduce(
        (sum, ts) => sum + ts.pointsPossible,
        0
      );

      // チームの回答状態
      const teamAnswer = challenge.teamAnswers[0];

      return {
        challengeId: challenge.challengeId,
        title: challenge.title,
        category: challenge.category,
        difficulty: challenge.difficulty,
        taskScoring,
        started: teamAnswer?.started ?? false,
        completed: teamAnswer?.completed ?? false,
        score: teamAnswer?.score ?? 0,
      };
    });

    return { success: true, challenges: result };
  } catch (error) {
    console.error('Get challenges error:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * チャレンジ詳細を取得（タスク・クルー含む）
 */
export async function getChallengeDetail(
  eventId: string,
  teamId: string,
  challengeId: string
): Promise<{
  success: boolean;
  challenge?: {
    title: string;
    category: string;
    description: string;
    region: string | null;
    sshKeyPairRequired: boolean;
    taskScoring: number;
    completed: boolean;
    score: number;
    tasks: Array<{
      taskId: string;
      title: string;
      content: string;
      taskNumber: number;
      locked: boolean;
      completed: boolean;
      usedClues: string[];
      clues: Array<{ title: string; order: number }>;
      clue1PenaltyPoints?: number;
      clue2PenaltyPoints?: number;
      clue3PenaltyPoints?: number;
    }>;
  };
  error?: string;
}> {
  try {
    // 1. チャレンジを取得
    const challenge = await prisma.challenge.findFirst({
      where: { eventId, challengeId },
      include: {
        tasks: {
          include: {
            clues: {
              orderBy: { order: 'asc' },
            },
          },
          orderBy: { taskNumber: 'asc' },
        },
        taskScorings: true,
        teamAnswers: {
          where: { teamId },
        },
      },
    });

    if (!challenge) {
      return { success: false, error: 'Challenge not found' };
    }

    // 2. タスク進捗を取得
    const taskProgressList = await prisma.taskProgress.findMany({
      where: {
        teamId,
        taskId: { in: challenge.tasks.map((t) => t.titleId) },
      },
    });

    const progressMap = new Map(taskProgressList.map((tp) => [tp.taskId, tp]));

    // 3. タスク採点設定をマップ
    const scoringMap = new Map(
      challenge.taskScorings.map((ts) => [ts.titleId, ts])
    );

    // 4. 結果を構築
    const taskScoring = challenge.taskScorings.reduce(
      (sum, ts) => sum + ts.pointsPossible,
      0
    );

    const teamAnswer = challenge.teamAnswers[0];

    const tasks = challenge.tasks.map((task) => {
      const progress = progressMap.get(task.titleId);
      const scoring = scoringMap.get(task.titleId);

      // 使用済みクルーの説明を抽出
      const usedClues =
        (progress?.usedClues as Array<{ description: string }>) || [];

      return {
        taskId: task.titleId,
        title: task.title,
        content: task.content,
        taskNumber: task.taskNumber,
        locked: progress?.locked ?? true,
        completed: progress?.completed ?? false,
        usedClues: usedClues.map((c) => c.description),
        clues: task.clues.map((c) => ({
          title: c.title,
          order: c.order,
        })),
        clue1PenaltyPoints: scoring?.clue1PenaltyPoints,
        clue2PenaltyPoints: scoring?.clue2PenaltyPoints,
        clue3PenaltyPoints: scoring?.clue3PenaltyPoints,
      };
    });

    return {
      success: true,
      challenge: {
        title: challenge.title,
        category: challenge.category,
        description: challenge.description,
        region: challenge.region,
        sshKeyPairRequired: challenge.sshKeyPairRequired,
        taskScoring,
        completed: teamAnswer?.completed ?? false,
        score: teamAnswer?.score ?? 0,
        tasks,
      },
    };
  } catch (error) {
    console.error('Get challenge detail error:', error);
    return { success: false, error: String(error) };
  }
}

export { prisma };
