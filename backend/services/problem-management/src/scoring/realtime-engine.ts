/**
 * Real-time Scoring Engine
 *
 * リアルタイム採点エンジン - 定期的な採点実行とリーダーボード更新を管理
 */

import type {
  CloudCredentials,
  Event,
  Leaderboard,
  LeaderboardEntry,
  Problem,
  ScoringResult,
} from '../types';
import type { ScoringEngine, ScoringRequest } from './engine';

// =============================================================================
// Types
// =============================================================================

/**
 * 参加者情報
 */
interface Participant {
  id: string;
  name: string;
  teamId?: string;
  teamName?: string;
  credentials: CloudCredentials;
}

/**
 * リアルタイムスコアリングセッション
 */
interface ScoringSession {
  eventId: string;
  event: Event;
  problems: Problem[];
  participants: Participant[];
  isActive: boolean;
  intervalId?: ReturnType<typeof setInterval>;
  lastScoringAt?: Date;
  scoringRound: number;
}

/**
 * リアルタイムエンジン設定
 */
export interface RealtimeScoringConfig {
  /** 採点間隔（ミリ秒） */
  scoringIntervalMs: number;
  /** リーダーボード更新間隔（ミリ秒） */
  leaderboardUpdateIntervalMs: number;
  /** 最大同時セッション数 */
  maxConcurrentSessions: number;
  /** リーダーボードフリーズ前の時間（ミリ秒） */
  freezeBeforeEndMs: number;
}

/**
 * リーダーボード更新イベント
 */
export interface LeaderboardUpdate {
  eventId: string;
  leaderboard: Leaderboard;
  timestamp: Date;
}

/**
 * スコア更新イベント
 */
export interface ScoreUpdate {
  eventId: string;
  participantId: string;
  teamId?: string;
  problemId: string;
  score: number;
  maxScore: number;
  previousScore?: number;
  timestamp: Date;
}

/**
 * イベントリスナー型
 */
export type LeaderboardUpdateListener = (update: LeaderboardUpdate) => void;
export type ScoreUpdateListener = (update: ScoreUpdate) => void;

// =============================================================================
// Real-time Scoring Engine
// =============================================================================

/**
 * リアルタイム採点エンジン
 *
 * イベント開催中のリアルタイム採点とリーダーボード更新を管理
 */
export class RealtimeScoringEngine {
  private scoringEngine: ScoringEngine;
  private config: RealtimeScoringConfig;
  private sessions: Map<string, ScoringSession> = new Map();
  private leaderboards: Map<string, Leaderboard> = new Map();
  private scoreHistory: Map<string, Map<string, ScoringResult[]>> = new Map();

  private leaderboardListeners: LeaderboardUpdateListener[] = [];
  private scoreListeners: ScoreUpdateListener[] = [];

  constructor(
    scoringEngine: ScoringEngine,
    config?: Partial<RealtimeScoringConfig>
  ) {
    this.scoringEngine = scoringEngine;
    this.config = {
      scoringIntervalMs: config?.scoringIntervalMs ?? 60000, // 1分
      leaderboardUpdateIntervalMs: config?.leaderboardUpdateIntervalMs ?? 30000, // 30秒
      maxConcurrentSessions: config?.maxConcurrentSessions ?? 10,
      freezeBeforeEndMs: config?.freezeBeforeEndMs ?? 900000, // 15分
    };

    // 採点結果をサブスクライブ
    this.scoringEngine.subscribe(this.handleScoringResult.bind(this));
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  /**
   * リアルタイム採点セッションを開始
   */
  startSession(
    event: Event,
    problems: Problem[],
    participants: Participant[]
  ): void {
    if (this.sessions.has(event.id)) {
      console.warn(
        `[RealtimeScoring] Session already exists for event ${event.id}`
      );
      return;
    }

    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.config.maxConcurrentSessions}) reached`
      );
    }

    const session: ScoringSession = {
      eventId: event.id,
      event,
      problems,
      participants,
      isActive: true,
      scoringRound: 0,
    };

    // 初期リーダーボードを作成
    this.initializeLeaderboard(event.id, participants);

    // 採点間隔を設定
    const intervalMs = event.scoringIntervalMinutes * 60 * 1000;
    session.intervalId = setInterval(() => {
      this.executeScoringRound(event.id);
    }, intervalMs);

    this.sessions.set(event.id, session);

    console.log(`[RealtimeScoring] Session started for event ${event.id}`);
    console.log(
      `[RealtimeScoring] Participants: ${participants.length}, Problems: ${problems.length}`
    );
    console.log(`[RealtimeScoring] Scoring interval: ${intervalMs}ms`);

    // 最初の採点を即座に実行
    this.executeScoringRound(event.id);
  }

  /**
   * セッションを停止
   */
  stopSession(eventId: string): void {
    const session = this.sessions.get(eventId);
    if (!session) {
      return;
    }

    session.isActive = false;

    if (session.intervalId) {
      clearInterval(session.intervalId);
    }

    this.sessions.delete(eventId);
    console.log(`[RealtimeScoring] Session stopped for event ${eventId}`);
  }

  /**
   * セッションを一時停止
   */
  pauseSession(eventId: string): void {
    const session = this.sessions.get(eventId);
    if (!session) {
      return;
    }

    session.isActive = false;

    if (session.intervalId) {
      clearInterval(session.intervalId);
      session.intervalId = undefined;
    }

    console.log(`[RealtimeScoring] Session paused for event ${eventId}`);
  }

  /**
   * セッションを再開
   */
  resumeSession(eventId: string): void {
    const session = this.sessions.get(eventId);
    if (!session || session.isActive) {
      return;
    }

    session.isActive = true;

    const intervalMs = session.event.scoringIntervalMinutes * 60 * 1000;
    session.intervalId = setInterval(() => {
      this.executeScoringRound(eventId);
    }, intervalMs);

    console.log(`[RealtimeScoring] Session resumed for event ${eventId}`);

    // 再開時に採点を実行
    this.executeScoringRound(eventId);
  }

  // ===========================================================================
  // Scoring Execution
  // ===========================================================================

  /**
   * 採点ラウンドを実行
   */
  private async executeScoringRound(eventId: string): Promise<void> {
    const session = this.sessions.get(eventId);
    if (!session || !session.isActive) {
      return;
    }

    session.scoringRound++;
    session.lastScoringAt = new Date();

    console.log(
      `[RealtimeScoring] Starting scoring round ${session.scoringRound} for event ${eventId}`
    );

    // 全参加者 × 全問題の採点リクエストを作成
    const requests: ScoringRequest[] = [];

    for (const participant of session.participants) {
      for (const problem of session.problems) {
        requests.push({
          eventId,
          problemId: problem.id,
          competitorAccountId: participant.id,
          teamId: participant.teamId,
          credentials: participant.credentials,
          problem,
        });
      }
    }

    // 採点をエンキュー
    const jobIds = this.scoringEngine.enqueueBatch(requests);
    console.log(`[RealtimeScoring] Enqueued ${jobIds.length} scoring jobs`);
  }

  /**
   * 手動で採点を実行
   */
  triggerScoring(eventId: string): void {
    this.executeScoringRound(eventId);
  }

  /**
   * 特定の参加者の採点を実行
   */
  triggerParticipantScoring(eventId: string, participantId: string): void {
    const session = this.sessions.get(eventId);
    if (!session) {
      throw new Error(`Session not found: ${eventId}`);
    }

    const participant = session.participants.find(
      (p) => p.id === participantId
    );
    if (!participant) {
      throw new Error(`Participant not found: ${participantId}`);
    }

    const requests: ScoringRequest[] = session.problems.map((problem) => ({
      eventId,
      problemId: problem.id,
      competitorAccountId: participant.id,
      teamId: participant.teamId,
      credentials: participant.credentials,
      problem,
    }));

    this.scoringEngine.enqueueBatch(requests);
    console.log(
      `[RealtimeScoring] Triggered scoring for participant ${participantId}`
    );
  }

  // ===========================================================================
  // Result Handling
  // ===========================================================================

  /**
   * 採点結果を処理
   */
  private handleScoringResult(result: ScoringResult): void {
    const { eventId, problemId, competitorAccountId, teamId } = result;

    // スコア履歴を更新
    this.updateScoreHistory(eventId, competitorAccountId, result);

    // リーダーボードを更新
    this.updateLeaderboard(eventId);

    // スコア更新イベントを通知
    const previousScore = this.getPreviousScore(
      eventId,
      competitorAccountId,
      problemId
    );
    const update: ScoreUpdate = {
      eventId,
      participantId: competitorAccountId,
      teamId,
      problemId,
      score: result.totalScore,
      maxScore: result.maxTotalScore,
      previousScore,
      timestamp: new Date(),
    };

    this.notifyScoreUpdate(update);
  }

  /**
   * スコア履歴を更新
   */
  private updateScoreHistory(
    eventId: string,
    participantId: string,
    result: ScoringResult
  ): void {
    if (!this.scoreHistory.has(eventId)) {
      this.scoreHistory.set(eventId, new Map());
    }

    const eventHistory = this.scoreHistory.get(eventId)!;
    if (!eventHistory.has(participantId)) {
      eventHistory.set(participantId, []);
    }

    eventHistory.get(participantId)!.push(result);
  }

  /**
   * 前回のスコアを取得
   */
  private getPreviousScore(
    eventId: string,
    participantId: string,
    problemId: string
  ): number | undefined {
    const eventHistory = this.scoreHistory.get(eventId);
    if (!eventHistory) return undefined;

    const participantHistory = eventHistory.get(participantId);
    if (!participantHistory || participantHistory.length < 2) return undefined;

    // 同じ問題の前回結果を探す
    for (let i = participantHistory.length - 2; i >= 0; i--) {
      if (participantHistory[i].problemId === problemId) {
        return participantHistory[i].totalScore;
      }
    }

    return undefined;
  }

  // ===========================================================================
  // Leaderboard Management
  // ===========================================================================

  /**
   * リーダーボードを初期化
   */
  private initializeLeaderboard(
    eventId: string,
    participants: Participant[]
  ): void {
    const entries: LeaderboardEntry[] = participants.map((p, index) => ({
      rank: index + 1,
      participantId: p.id,
      teamId: p.teamId,
      name: p.teamName || p.name,
      totalScore: 0,
      problemScores: {},
      lastScoredAt: new Date(),
      trend: 'same' as const,
    }));

    const leaderboard: Leaderboard = {
      eventId,
      entries,
      updatedAt: new Date(),
      isFrozen: false,
    };

    this.leaderboards.set(eventId, leaderboard);
  }

  /**
   * リーダーボードを更新
   */
  private updateLeaderboard(eventId: string): void {
    const session = this.sessions.get(eventId);
    const leaderboard = this.leaderboards.get(eventId);
    if (!session || !leaderboard) return;

    // フリーズチェック
    const now = new Date();
    const endTime = new Date(session.event.endTime);
    const freezeTime = new Date(
      endTime.getTime() - this.config.freezeBeforeEndMs
    );

    if (now >= freezeTime && session.event.freezeLeaderboardMinutes) {
      if (!leaderboard.isFrozen) {
        leaderboard.isFrozen = true;
        console.log(
          `[RealtimeScoring] Leaderboard frozen for event ${eventId}`
        );
      }
      // フリーズ中は更新しない（内部では更新するがクライアントには古い状態を送る）
    }

    const eventHistory = this.scoreHistory.get(eventId);
    if (!eventHistory) return;

    // 各参加者のスコアを集計
    const previousRanks = new Map(
      leaderboard.entries.map((e) => [e.participantId || e.teamId, e.rank])
    );

    const updatedEntries: LeaderboardEntry[] = session.participants.map(
      (participant) => {
        const participantHistory = eventHistory.get(participant.id) || [];

        // 問題ごとの最新スコアを取得
        const problemScores: Record<string, number> = {};
        let lastScoredAt = new Date(0);

        // 履歴を走査して各問題の最新スコアを取得（後のエントリで上書き）
        for (const result of participantHistory) {
          problemScores[result.problemId] = result.totalScore;

          if (result.scoredAt > lastScoredAt) {
            lastScoredAt = result.scoredAt;
          }
        }

        // 各問題の最新スコアのみを合計（履歴全体ではなく）
        const totalScore = Object.values(problemScores).reduce(
          (sum, score) => sum + score,
          0
        );

        return {
          rank: 0, // 後で設定
          participantId: participant.id,
          teamId: participant.teamId,
          name: participant.teamName || participant.name,
          totalScore,
          problemScores,
          lastScoredAt,
          trend: 'same' as const,
        };
      }
    );

    // スコアでソートしてランク付け
    updatedEntries.sort((a, b) => {
      // スコアの降順
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }
      // 同点の場合は最終採点時刻の昇順（早い方が上位）
      return a.lastScoredAt.getTime() - b.lastScoredAt.getTime();
    });

    // ランクとトレンドを設定
    updatedEntries.forEach((entry, index) => {
      entry.rank = index + 1;

      const previousRank = previousRanks.get(
        entry.participantId || entry.teamId
      );
      if (previousRank !== undefined) {
        if (entry.rank < previousRank) {
          entry.trend = 'up';
        } else if (entry.rank > previousRank) {
          entry.trend = 'down';
        } else {
          entry.trend = 'same';
        }
      }
    });

    leaderboard.entries = updatedEntries;
    leaderboard.updatedAt = new Date();

    // リーダーボード更新を通知（フリーズ中でも通知するが、フリーズフラグ付き）
    this.notifyLeaderboardUpdate({
      eventId,
      leaderboard,
      timestamp: new Date(),
    });
  }

  /**
   * リーダーボードを取得
   */
  getLeaderboard(eventId: string): Leaderboard | undefined {
    return this.leaderboards.get(eventId);
  }

  /**
   * 参加者のスコア履歴を取得
   */
  getParticipantHistory(
    eventId: string,
    participantId: string
  ): ScoringResult[] {
    return this.scoreHistory.get(eventId)?.get(participantId) || [];
  }

  // ===========================================================================
  // Event Listeners
  // ===========================================================================

  /**
   * リーダーボード更新リスナーを追加
   */
  onLeaderboardUpdate(listener: LeaderboardUpdateListener): () => void {
    this.leaderboardListeners.push(listener);
    return () => {
      const index = this.leaderboardListeners.indexOf(listener);
      if (index >= 0) {
        this.leaderboardListeners.splice(index, 1);
      }
    };
  }

  /**
   * スコア更新リスナーを追加
   */
  onScoreUpdate(listener: ScoreUpdateListener): () => void {
    this.scoreListeners.push(listener);
    return () => {
      const index = this.scoreListeners.indexOf(listener);
      if (index >= 0) {
        this.scoreListeners.splice(index, 1);
      }
    };
  }

  private notifyLeaderboardUpdate(update: LeaderboardUpdate): void {
    for (const listener of this.leaderboardListeners) {
      try {
        listener(update);
      } catch (error) {
        console.error('[RealtimeScoring] Leaderboard listener error:', error);
      }
    }
  }

  private notifyScoreUpdate(update: ScoreUpdate): void {
    for (const listener of this.scoreListeners) {
      try {
        listener(update);
      } catch (error) {
        console.error('[RealtimeScoring] Score listener error:', error);
      }
    }
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * セッション統計を取得
   */
  getSessionStats(eventId: string): SessionStats | undefined {
    const session = this.sessions.get(eventId);
    if (!session) return undefined;

    const leaderboard = this.leaderboards.get(eventId);

    return {
      eventId,
      isActive: session.isActive,
      scoringRound: session.scoringRound,
      lastScoringAt: session.lastScoringAt,
      participantCount: session.participants.length,
      problemCount: session.problems.length,
      leaderboardEntries: leaderboard?.entries.length ?? 0,
      isFrozen: leaderboard?.isFrozen ?? false,
    };
  }

  /**
   * 全体統計を取得
   */
  getGlobalStats(): GlobalStats {
    return {
      activeSessions: this.sessions.size,
      totalParticipants: Array.from(this.sessions.values()).reduce(
        (sum, s) => sum + s.participants.length,
        0
      ),
      scoringEngineStats: this.scoringEngine.getStats(),
    };
  }
}

// =============================================================================
// Types (Statistics)
// =============================================================================

interface SessionStats {
  eventId: string;
  isActive: boolean;
  scoringRound: number;
  lastScoringAt?: Date;
  participantCount: number;
  problemCount: number;
  leaderboardEntries: number;
  isFrozen: boolean;
}

interface GlobalStats {
  activeSessions: number;
  totalParticipants: number;
  scoringEngineStats: {
    queuedJobs: number;
    activeJobs: number;
    registeredProviders: string[];
  };
}

// =============================================================================
// Factory
// =============================================================================

/**
 * リアルタイム採点エンジンを作成
 */
export function createRealtimeScoringEngine(
  scoringEngine: ScoringEngine,
  config?: Partial<RealtimeScoringConfig>
): RealtimeScoringEngine {
  return new RealtimeScoringEngine(scoringEngine, config);
}
