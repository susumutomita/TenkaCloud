/**
 * Admin Analytics API Client
 *
 * 管理画面分析ダッシュボード用の API クライアント
 */

import { get } from './client';

/**
 * 分析データ
 */
export interface AnalyticsData {
  overview: OverviewMetrics;
  eventTimeline: EventTimelineEntry[];
  scoreDistribution: ScoreDistributionEntry[];
  teamComparison: TeamComparisonEntry[];
}

/**
 * 概要メトリクス
 */
export interface OverviewMetrics {
  totalEvents: number;
  totalParticipants: number;
  avgScore: number;
  completionRate: number;
}

/**
 * イベントタイムラインエントリ
 */
export interface EventTimelineEntry {
  month: string;
  eventCount: number;
  participantCount: number;
}

/**
 * スコア分布エントリ
 */
export interface ScoreDistributionEntry {
  category: string;
  value: number;
}

/**
 * チーム比較エントリ
 */
export interface TeamComparisonEntry {
  teamName: string;
  score: number;
  memberCount: number;
  completionRate: number;
}

/**
 * 分析データを取得
 */
export async function getAnalyticsData(): Promise<AnalyticsData> {
  return get<AnalyticsData>('/admin/analytics');
}
