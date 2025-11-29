/**
 * Event Repository
 *
 * イベントの永続化とクエリを担当するリポジトリ
 */

import type {
  Event,
  EventStatus,
  EventType,
  Leaderboard,
  ScoringResult,
} from '../types';

/**
 * イベントリポジトリインターフェース
 */
export interface IEventRepository {
  /**
   * イベントの作成
   * @param event イベントデータ
   * @returns 作成されたイベント
   */
  create(event: Omit<Event, 'id' | 'createdAt' | 'updatedAt'>): Promise<Event>;

  /**
   * イベントの更新
   * @param id イベントID
   * @param updates 更新データ
   * @returns 更新されたイベント
   */
  update(id: string, updates: Partial<Event>): Promise<Event>;

  /**
   * イベントの削除
   * @param id イベントID
   */
  delete(id: string): Promise<void>;

  /**
   * イベントの取得
   * @param id イベントID
   * @returns イベント（存在しない場合は null）
   */
  findById(id: string): Promise<Event | null>;

  /**
   * テナントのイベント一覧の取得
   * @param tenantId テナントID
   * @param options フィルターオプション
   * @returns イベント一覧
   */
  findByTenant(
    tenantId: string,
    options?: EventFilterOptions
  ): Promise<Event[]>;

  /**
   * イベントのステータス更新
   * @param id イベントID
   * @param status 新しいステータス
   */
  updateStatus(id: string, status: EventStatus): Promise<void>;
}

/**
 * イベントフィルターオプション
 */
export interface EventFilterOptions {
  tenantId?: string;
  type?: EventType;
  status?: EventStatus | EventStatus[];
  startAfter?: Date;
  startBefore?: Date;
  limit?: number;
  offset?: number;
}

/**
 * リーダーボードリポジトリインターフェース
 */
export interface ILeaderboardRepository {
  /**
   * リーダーボードの取得
   * @param eventId イベントID
   * @returns リーダーボード
   */
  getLeaderboard(eventId: string): Promise<Leaderboard | null>;

  /**
   * スコアの更新
   * @param eventId イベントID
   * @param scoringResult 採点結果
   */
  updateScore(eventId: string, scoringResult: ScoringResult): Promise<void>;

  /**
   * リーダーボードの凍結
   * @param eventId イベントID
   */
  freezeLeaderboard(eventId: string): Promise<void>;

  /**
   * リーダーボードの凍結解除
   * @param eventId イベントID
   */
  unfreezeLeaderboard(eventId: string): Promise<void>;

  /**
   * リーダーボードのリセット
   * @param eventId イベントID
   */
  resetLeaderboard(eventId: string): Promise<void>;
}

/**
 * インメモリイベントリポジトリ実装（開発・テスト用）
 */
export class InMemoryEventRepository implements IEventRepository {
  private events: Map<string, Event> = new Map();
  private idCounter = 0;

  async create(
    eventData: Omit<Event, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Event> {
    const id = `event-${++this.idCounter}`;
    const now = new Date();
    const event: Event = {
      ...eventData,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.events.set(id, event);
    return event;
  }

  async update(id: string, updates: Partial<Event>): Promise<Event> {
    const existing = this.events.get(id);
    if (!existing) {
      throw new Error(`Event with id '${id}' not found`);
    }
    const updated = {
      ...existing,
      ...updates,
      id, // id は変更不可
      updatedAt: new Date(),
    };
    this.events.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!this.events.has(id)) {
      throw new Error(`Event with id '${id}' not found`);
    }
    this.events.delete(id);
  }

  async findById(id: string): Promise<Event | null> {
    return this.events.get(id) || null;
  }

  async findByTenant(
    tenantId: string,
    options?: EventFilterOptions
  ): Promise<Event[]> {
    let results = Array.from(this.events.values()).filter(
      (e) => e.tenantId === tenantId
    );

    // フィルタリング
    if (options?.type) {
      results = results.filter((e) => e.type === options.type);
    }
    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      results = results.filter((e) => statuses.includes(e.status));
    }
    if (options?.startAfter) {
      results = results.filter((e) => e.startTime > options.startAfter!);
    }
    if (options?.startBefore) {
      results = results.filter((e) => e.startTime < options.startBefore!);
    }

    // ソート（開始日時の降順）
    results.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

    // ページネーション
    const offset = options?.offset || 0;
    const limit = options?.limit || 100;
    results = results.slice(offset, offset + limit);

    return results;
  }

  async updateStatus(id: string, status: EventStatus): Promise<void> {
    await this.update(id, { status });
  }

  // テスト用ヘルパー
  clear(): void {
    this.events.clear();
    this.idCounter = 0;
  }

  /**
   * イベント件数を取得（フィルタ対応）
   */
  async count(options?: EventFilterOptions): Promise<number> {
    let results = Array.from(this.events.values());

    if (options?.tenantId) {
      results = results.filter((e) => e.tenantId === options.tenantId);
    }
    if (options?.type) {
      results = results.filter((e) => e.type === options.type);
    }
    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      results = results.filter((e) => statuses.includes(e.status));
    }
    if (options?.startAfter) {
      results = results.filter((e) => e.startTime > options.startAfter!);
    }
    if (options?.startBefore) {
      results = results.filter((e) => e.startTime < options.startBefore!);
    }

    return results.length;
  }
}

/**
 * インメモリリーダーボードリポジトリ実装（開発・テスト用）
 */
export class InMemoryLeaderboardRepository implements ILeaderboardRepository {
  private leaderboards: Map<string, Leaderboard> = new Map();

  async getLeaderboard(eventId: string): Promise<Leaderboard | null> {
    return this.leaderboards.get(eventId) || null;
  }

  async updateScore(
    eventId: string,
    scoringResult: ScoringResult
  ): Promise<void> {
    let leaderboard = this.leaderboards.get(eventId);

    if (!leaderboard) {
      leaderboard = {
        eventId,
        entries: [],
        updatedAt: new Date(),
        isFrozen: false,
      };
    }

    if (leaderboard.isFrozen) {
      // 凍結中は内部的にはスコアを更新するが、表示順位は変更しない
      console.log(
        `Leaderboard for event ${eventId} is frozen. Score updated but rank unchanged.`
      );
    }

    // エントリを検索または作成
    const entryId = scoringResult.teamId || scoringResult.competitorAccountId;
    let entry = leaderboard.entries.find(
      (e) => (e.teamId || e.participantId) === entryId
    );

    if (!entry) {
      entry = {
        rank: leaderboard.entries.length + 1,
        teamId: scoringResult.teamId,
        participantId: scoringResult.teamId
          ? undefined
          : scoringResult.competitorAccountId,
        name: entryId, // 実際の実装では名前を別途取得
        totalScore: 0,
        problemScores: {},
        lastScoredAt: new Date(),
      };
      leaderboard.entries.push(entry);
    }

    // スコアを更新
    const previousTotal = entry.totalScore;
    entry.problemScores[scoringResult.problemId] = scoringResult.totalScore;
    entry.totalScore = Object.values(entry.problemScores).reduce(
      (sum, score) => sum + score,
      0
    );
    entry.lastScoredAt = scoringResult.scoredAt;

    // トレンドを設定
    if (entry.totalScore > previousTotal) {
      entry.trend = 'up';
    } else if (entry.totalScore < previousTotal) {
      entry.trend = 'down';
    } else {
      entry.trend = 'same';
    }

    // 順位を再計算（凍結中でなければ）
    if (!leaderboard.isFrozen) {
      leaderboard.entries.sort((a, b) => {
        if (b.totalScore !== a.totalScore) {
          return b.totalScore - a.totalScore;
        }
        // 同点の場合は最終採点時刻が早い方が上位
        return a.lastScoredAt.getTime() - b.lastScoredAt.getTime();
      });

      leaderboard.entries.forEach((e, index) => {
        e.rank = index + 1;
      });
    }

    leaderboard.updatedAt = new Date();
    this.leaderboards.set(eventId, leaderboard);
  }

  async freezeLeaderboard(eventId: string): Promise<void> {
    const leaderboard = this.leaderboards.get(eventId);
    if (leaderboard) {
      leaderboard.isFrozen = true;
      this.leaderboards.set(eventId, leaderboard);
    }
  }

  async unfreezeLeaderboard(eventId: string): Promise<void> {
    const leaderboard = this.leaderboards.get(eventId);
    if (leaderboard) {
      leaderboard.isFrozen = false;
      // 順位を再計算
      leaderboard.entries.sort((a, b) => b.totalScore - a.totalScore);
      leaderboard.entries.forEach((e, index) => {
        e.rank = index + 1;
      });
      this.leaderboards.set(eventId, leaderboard);
    }
  }

  async resetLeaderboard(eventId: string): Promise<void> {
    this.leaderboards.delete(eventId);
  }

  // テスト用ヘルパー
  clear(): void {
    this.leaderboards.clear();
  }
}
