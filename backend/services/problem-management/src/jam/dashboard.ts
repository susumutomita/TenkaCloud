/**
 * ダッシュボード・リーダーボード機能
 *
 * minoru1/RestApp/LambdaFunction/Dashboard/dashboard.py を TypeScript で再実装
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * リーダーボードエントリの型
 */
export interface LeaderboardEntry {
  rank: number;
  teamId: string;
  teamName: string;
  score: number;
  completedChallenges: number;
  totalChallenges: number;
  lastUpdateTime: bigint;
}

/**
 * チャレンジ統計の型
 */
export interface ChallengeStats {
  challengeId: string;
  title: string;
  totalStarted: number;
  totalCompleted: number;
  averageScore: number;
  teamsStarted: string[];
  teamsCompleted: string[];
}

/**
 * イベントダッシュボードの型
 */
export interface EventDashboard {
  eventId: string;
  eventName: string;
  leaderboard: LeaderboardEntry[];
  challengeStats: ChallengeStats[];
  totalTeams: number;
  totalChallenges: number;
  recentLogs: Array<{
    teamName: string;
    message: string;
    timestamp: bigint;
  }>;
}

/**
 * リーダーボードを取得
 *
 * minoru1/RestApp/LambdaFunction/Dashboard/dashboard.py の getLeaderboard を再実装
 */
export async function getLeaderboard(
  eventId: string,
  limit = 100
): Promise<LeaderboardEntry[]> {
  try {
    // イベントに参加しているチームのスコア集計
    const teamScores = await prisma.teamChallengeAnswer.groupBy({
      by: ['teamId'],
      where: {
        challenge: {
          eventId,
        },
      },
      _sum: {
        score: true,
      },
      _count: {
        _all: true,
      },
    });

    // チーム情報を取得
    const teamIds = teamScores.map((ts) => ts.teamId);
    const teams = await prisma.team.findMany({
      where: { id: { in: teamIds } },
    });

    const teamMap = new Map(teams.map((t) => [t.id, t]));

    // 完了チャレンジ数を取得
    const completedCounts = await prisma.teamChallengeAnswer.groupBy({
      by: ['teamId'],
      where: {
        challenge: {
          eventId,
        },
        completed: true,
      },
      _count: {
        _all: true,
      },
    });

    const completedMap = new Map(
      completedCounts.map((c) => [c.teamId, c._count._all])
    );

    // 総チャレンジ数を取得
    const totalChallenges = await prisma.challenge.count({
      where: { eventId },
    });

    // リーダーボードエントリを構築
    const entries: Omit<LeaderboardEntry, 'rank'>[] = teamScores.map((ts) => {
      const team = teamMap.get(ts.teamId);
      return {
        teamId: ts.teamId,
        teamName: team?.teamName || 'Unknown',
        score: ts._sum.score || 0,
        completedChallenges: completedMap.get(ts.teamId) || 0,
        totalChallenges,
        lastUpdateTime: BigInt(Date.now()),
      };
    });

    // スコア降順でソート
    entries.sort((a, b) => b.score - a.score);

    // ランクを付与
    const leaderboard: LeaderboardEntry[] = entries
      .slice(0, limit)
      .map((entry, index) => ({
        ...entry,
        rank: index + 1,
      }));

    return leaderboard;
  } catch (error) {
    console.error('Get leaderboard error:', error);
    throw error;
  }
}

/**
 * チームのダッシュボード情報を取得
 */
export async function getTeamDashboard(
  eventId: string,
  teamId: string
): Promise<{
  team: {
    teamId: string;
    teamName: string;
    rank: number;
    score: number;
    completedChallenges: number;
    totalChallenges: number;
  };
  challenges: Array<{
    challengeId: string;
    title: string;
    category: string;
    started: boolean;
    completed: boolean;
    score: number;
    maxScore: number;
  }>;
  recentActivity: Array<{
    message: string;
    timestamp: bigint;
  }>;
}> {
  try {
    // チーム情報を取得
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new Error('Team not found');
    }

    // リーダーボードからランクを取得
    const leaderboard = await getLeaderboard(eventId);
    const teamEntry = leaderboard.find((e) => e.teamId === teamId);

    // チャレンジ一覧と進捗を取得
    const challenges = await prisma.challenge.findMany({
      where: { eventId },
      include: {
        taskScorings: true,
        teamAnswers: {
          where: { teamId },
        },
      },
    });

    const challengeList = challenges.map((c) => {
      const teamAnswer = c.teamAnswers[0];
      const maxScore = c.taskScorings.reduce(
        (sum, ts) => sum + ts.pointsPossible,
        0
      );

      return {
        challengeId: c.challengeId,
        title: c.title,
        category: c.category,
        started: teamAnswer?.started ?? false,
        completed: teamAnswer?.completed ?? false,
        score: teamAnswer?.score ?? 0,
        maxScore,
      };
    });

    // 最近のアクティビティ（イベントログ）を取得
    const recentLogs = await prisma.eventLog.findMany({
      where: {
        eventId,
        teamName: team.teamName,
      },
      orderBy: { dateTimeUTC: 'desc' },
      take: 10,
    });

    return {
      team: {
        teamId: team.id,
        teamName: team.teamName,
        rank: teamEntry?.rank ?? 0,
        score: teamEntry?.score ?? 0,
        completedChallenges: teamEntry?.completedChallenges ?? 0,
        totalChallenges: teamEntry?.totalChallenges ?? 0,
      },
      challenges: challengeList,
      recentActivity: recentLogs.map((log) => ({
        message: log.message,
        timestamp: log.dateTimeUTC,
      })),
    };
  } catch (error) {
    console.error('Get team dashboard error:', error);
    throw error;
  }
}

/**
 * チャレンジ統計を取得
 */
export async function getChallengeStatistics(
  eventId: string
): Promise<ChallengeStats[]> {
  try {
    const stats = await prisma.challengeStatistics.findMany({
      where: {
        challenge: {
          eventId,
        },
      },
      include: {
        challenge: true,
      },
    });

    return stats.map((s) => ({
      challengeId: s.challenge.challengeId,
      title: s.title,
      totalStarted: s.totalStartedChallenge,
      totalCompleted: s.totalCompletedChallenge,
      averageScore: s.averageScore,
      teamsStarted: s.teamsStartedChallenge,
      teamsCompleted: s.teamsCompletedChallenge,
    }));
  } catch (error) {
    console.error('Get challenge statistics error:', error);
    throw error;
  }
}

/**
 * イベント全体のダッシュボードを取得
 */
export async function getEventDashboard(
  eventId: string
): Promise<EventDashboard> {
  try {
    // イベント情報を取得（Eventモデルがある場合）
    const eventName = `Event ${eventId}`;

    // リーダーボード
    const leaderboard = await getLeaderboard(eventId, 50);

    // チャレンジ統計
    const challengeStats = await getChallengeStatistics(eventId);

    // 総チーム数
    const totalTeams = await prisma.team.count({
      where: {
        challengeAnswers: {
          some: {
            challenge: {
              eventId,
            },
          },
        },
      },
    });

    // 総チャレンジ数
    const totalChallenges = await prisma.challenge.count({
      where: { eventId },
    });

    // 最近のイベントログ
    const recentLogs = await prisma.eventLog.findMany({
      where: { eventId },
      orderBy: { dateTimeUTC: 'desc' },
      take: 20,
    });

    return {
      eventId,
      eventName,
      leaderboard,
      challengeStats,
      totalTeams,
      totalChallenges,
      recentLogs: recentLogs.map((log) => ({
        teamName: log.teamName,
        message: log.message,
        timestamp: log.dateTimeUTC,
      })),
    };
  } catch (error) {
    console.error('Get event dashboard error:', error);
    throw error;
  }
}

/**
 * リーダーボード履歴を保存（定期的に呼び出される）
 */
export async function saveLeaderboardSnapshot(eventId: string): Promise<void> {
  try {
    const leaderboard = await getLeaderboard(eventId);
    const timestamp = BigInt(Date.now());

    // 各チームのエントリを保存または更新
    for (const entry of leaderboard) {
      await prisma.teamLeaderboardEntry.upsert({
        where: {
          teamId_eventId: {
            teamId: entry.teamId,
            eventId,
          },
        },
        create: {
          teamId: entry.teamId,
          eventId,
          teamName: entry.teamName,
          score: entry.score,
          rank: entry.rank,
          timestamp,
          lastUpdateTime: timestamp,
        },
        update: {
          score: entry.score,
          rank: entry.rank,
          timestamp,
          lastUpdateTime: timestamp,
        },
      });

      // 履歴を追加
      await prisma.leaderboardEntryHistory.create({
        data: {
          teamId: entry.teamId,
          teamName: entry.teamName,
          eventId,
          score: entry.score,
          rank: entry.rank,
          teamTotalEffectiveScore: entry.score,
          timestamp,
          recordedAt: timestamp,
        },
      });
    }
  } catch (error) {
    console.error('Save leaderboard snapshot error:', error);
    throw error;
  }
}

export { prisma };
