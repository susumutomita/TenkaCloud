/**
 * イベントログ機能
 *
 * minoru1/RestApp/LambdaFunction/Dashboard/dashboard.py のログ機能を TypeScript で再実装
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * イベントログのタイプ
 */
export enum EventLogType {
  CHALLENGE_START = 'challenge_start',
  CHALLENGE_COMPLETE = 'challenge_complete',
  TASK_UNLOCK = 'task_unlock',
  TASK_COMPLETE = 'task_complete',
  CLUE_USED = 'clue_used',
  ANSWER_CORRECT = 'answer_correct',
  ANSWER_INCORRECT = 'answer_incorrect',
  SCORE_UPDATE = 'score_update',
  CONTEST_START = 'contest_start',
  CONTEST_END = 'contest_end',
  TEAM_REGISTER = 'team_register',
}

/**
 * イベントログエントリ
 */
export interface EventLogEntry {
  id: string;
  eventId: string;
  teamName: string;
  message: string;
  logType?: EventLogType;
  metadata?: Record<string, unknown>;
  timestamp: bigint;
}

/**
 * イベントログを追加
 */
export async function addEventLog(
  eventId: string,
  teamName: string,
  message: string,
  logType?: EventLogType,
  metadata?: Record<string, unknown>
): Promise<EventLogEntry> {
  try {
    const log = await prisma.eventLog.create({
      data: {
        eventId,
        teamName,
        message,
        dateTimeUTC: BigInt(Date.now()),
      },
    });

    return {
      id: log.id,
      eventId: log.eventId,
      teamName: log.teamName,
      message: log.message,
      logType,
      metadata,
      timestamp: log.dateTimeUTC,
    };
  } catch (error) {
    console.error('Add event log error:', error);
    throw error;
  }
}

/**
 * チャレンジ開始ログ
 */
export async function logChallengeStart(
  eventId: string,
  teamName: string,
  challengeTitle: string
): Promise<EventLogEntry> {
  return addEventLog(
    eventId,
    teamName,
    `Start ${challengeTitle}`,
    EventLogType.CHALLENGE_START,
    { challengeTitle }
  );
}

/**
 * チャレンジ完了ログ
 */
export async function logChallengeComplete(
  eventId: string,
  teamName: string,
  challengeTitle: string,
  score: number
): Promise<EventLogEntry> {
  return addEventLog(
    eventId,
    teamName,
    `Completed ${challengeTitle} with score ${score}`,
    EventLogType.CHALLENGE_COMPLETE,
    { challengeTitle, score }
  );
}

/**
 * タスク完了ログ
 */
export async function logTaskComplete(
  eventId: string,
  teamName: string,
  taskTitle: string,
  pointsEarned: number
): Promise<EventLogEntry> {
  return addEventLog(
    eventId,
    teamName,
    `Completed task: ${taskTitle} (+${pointsEarned} points)`,
    EventLogType.TASK_COMPLETE,
    { taskTitle, pointsEarned }
  );
}

/**
 * クルー使用ログ
 */
export async function logClueUsed(
  eventId: string,
  teamName: string,
  taskTitle: string,
  clueNumber: number,
  penaltyPoints: number
): Promise<EventLogEntry> {
  return addEventLog(
    eventId,
    teamName,
    `Used clue ${clueNumber} for ${taskTitle} (-${penaltyPoints} points penalty)`,
    EventLogType.CLUE_USED,
    { taskTitle, clueNumber, penaltyPoints }
  );
}

/**
 * 正解ログ
 */
export async function logAnswerCorrect(
  eventId: string,
  teamName: string,
  taskTitle: string
): Promise<EventLogEntry> {
  return addEventLog(
    eventId,
    teamName,
    `Correct answer for ${taskTitle}`,
    EventLogType.ANSWER_CORRECT,
    { taskTitle }
  );
}

/**
 * 不正解ログ
 */
export async function logAnswerIncorrect(
  eventId: string,
  teamName: string,
  taskTitle: string
): Promise<EventLogEntry> {
  return addEventLog(
    eventId,
    teamName,
    `Incorrect answer for ${taskTitle}`,
    EventLogType.ANSWER_INCORRECT,
    { taskTitle }
  );
}

/**
 * スコア更新ログ
 */
export async function logScoreUpdate(
  eventId: string,
  teamName: string,
  newScore: number,
  delta: number
): Promise<EventLogEntry> {
  const sign = delta >= 0 ? '+' : '';
  return addEventLog(
    eventId,
    teamName,
    `Score updated: ${newScore} (${sign}${delta})`,
    EventLogType.SCORE_UPDATE,
    { newScore, delta }
  );
}

/**
 * コンテスト開始ログ
 */
export async function logContestStart(
  eventId: string,
  contestName: string
): Promise<EventLogEntry> {
  return addEventLog(
    eventId,
    'SYSTEM',
    `Contest "${contestName}" has started`,
    EventLogType.CONTEST_START,
    { contestName }
  );
}

/**
 * コンテスト終了ログ
 */
export async function logContestEnd(
  eventId: string,
  contestName: string
): Promise<EventLogEntry> {
  return addEventLog(
    eventId,
    'SYSTEM',
    `Contest "${contestName}" has ended`,
    EventLogType.CONTEST_END,
    { contestName }
  );
}

/**
 * イベントログを取得（ページネーション対応）
 */
export async function getEventLogs(
  eventId: string,
  options?: {
    teamName?: string;
    limit?: number;
    offset?: number;
    since?: bigint;
  }
): Promise<{
  logs: EventLogEntry[];
  total: number;
  hasMore: boolean;
}> {
  try {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const where: {
      eventId: string;
      teamName?: string;
      dateTimeUTC?: { gte: bigint };
    } = { eventId };

    if (options?.teamName) {
      where.teamName = options.teamName;
    }

    if (options?.since) {
      where.dateTimeUTC = { gte: options.since };
    }

    const [logs, total] = await Promise.all([
      prisma.eventLog.findMany({
        where,
        orderBy: { dateTimeUTC: 'desc' },
        skip: offset,
        take: limit + 1, // 1つ多く取得してhasMoreを判定
      }),
      prisma.eventLog.count({ where }),
    ]);

    const hasMore = logs.length > limit;
    const resultLogs = hasMore ? logs.slice(0, limit) : logs;

    return {
      logs: resultLogs.map((log) => ({
        id: log.id,
        eventId: log.eventId,
        teamName: log.teamName,
        message: log.message,
        timestamp: log.dateTimeUTC,
      })),
      total,
      hasMore,
    };
  } catch (error) {
    console.error('Get event logs error:', error);
    throw error;
  }
}

/**
 * リアルタイムログ取得（WebSocket/SSE用）
 */
export async function getRecentLogs(
  eventId: string,
  since: bigint
): Promise<EventLogEntry[]> {
  try {
    const logs = await prisma.eventLog.findMany({
      where: {
        eventId,
        dateTimeUTC: { gt: since },
      },
      orderBy: { dateTimeUTC: 'asc' },
    });

    return logs.map((log) => ({
      id: log.id,
      eventId: log.eventId,
      teamName: log.teamName,
      message: log.message,
      timestamp: log.dateTimeUTC,
    }));
  } catch (error) {
    console.error('Get recent logs error:', error);
    throw error;
  }
}

export { prisma };
