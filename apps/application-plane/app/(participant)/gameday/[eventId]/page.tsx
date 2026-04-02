/**
 * GameDay Headquarters (司令部)
 *
 * チーム状態、ヘルスチェック、最近の攻撃履歴、URL設定
 */

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { HealthIndicator } from '@/components/gameday';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  getErrorMessage,
  getErrorType,
  Input,
} from '@/components/ui';
import {
  getMonitoringStatus,
  getTeamDashboard,
  updateTeamUrl,
} from '@/lib/api/gameday';
import type {
  AttackLog,
  HealthCheckResult,
  TeamDashboard,
} from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';

export default function GamedayHQPage() {
  const { eventId, teamId } = useGamedaySession();
  const [dashboard, setDashboard] = useState<TeamDashboard | null>(null);
  const [healthChecks, setHealthChecks] = useState<HealthCheckResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    if (!eventId || !teamId) {
      setLoading(false);
      return;
    }
    try {
      const [dashData, monData] = await Promise.all([
        getTeamDashboard(eventId, teamId),
        getMonitoringStatus(eventId, teamId),
      ]);
      setDashboard(dashData);
      setHealthChecks(monData.checks);
      if (dashData.team.websiteUrl) setWebsiteUrl(dashData.team.websiteUrl);
      if (dashData.team.apiUrl) setApiUrl(dashData.team.apiUrl);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました')
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 15000);
    return () => clearInterval(id);
  }, [fetchData]);

  const handleSaveUrls = async () => {
    if (!eventId || !teamId) return;
    setSaving(true);
    try {
      await updateTeamUrl(eventId, teamId, { websiteUrl, apiUrl });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
      </div>
    );
  }

  if (!teamId) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
        <p className="text-text-muted">チームを選択してください</p>
        <Link
          href={`/events/${eventId}`}
          className="text-hn-accent hover:text-hn-accent-bright underline"
        >
          イベントページへ戻る
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        message={getErrorMessage(error)}
        type={getErrorType(error)}
        onRetry={fetchData}
      />
    );
  }

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  // Derive latest status per check type
  const latestWebsite = healthChecks.find((c) => c.checkType === 'website');
  const latestApi = healthChecks.find((c) => c.checkType === 'api');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
        <span className="text-hn-accent font-mono">&gt;_</span>
        司令部
      </h1>

      {/* Application Status */}
      {healthChecks.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardContent className="flex items-center gap-4 py-5">
              <HealthIndicator isHealthy={latestWebsite?.isHealthy ?? false} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-muted font-mono uppercase">
                  Website
                </div>
                <div className="text-lg font-semibold text-text-primary">
                  {latestWebsite
                    ? latestWebsite.isHealthy
                      ? '正常'
                      : '異常'
                    : '未チェック'}
                </div>
              </div>
              {latestWebsite?.responseTimeMs != null && (
                <Badge variant="default" badgeStyle="subtle">
                  {latestWebsite.responseTimeMs}ms
                </Badge>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-4 py-5">
              <HealthIndicator isHealthy={latestApi?.isHealthy ?? false} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-muted font-mono uppercase">
                  API
                </div>
                <div className="text-lg font-semibold text-text-primary">
                  {latestApi
                    ? latestApi.isHealthy
                      ? '正常'
                      : '異常'
                    : '未チェック'}
                </div>
              </div>
              {latestApi?.responseTimeMs != null && (
                <Badge variant="default" badgeStyle="subtle">
                  {latestApi.responseTimeMs}ms
                </Badge>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Health Checks */}
        <Card>
          <CardHeader>
            <span className="font-semibold text-text-primary">
              ヘルスチェック
            </span>
          </CardHeader>
          <CardContent className="space-y-3">
            {healthChecks.length === 0 ? (
              <p className="text-text-muted text-sm">データなし</p>
            ) : (
              healthChecks.slice(0, 10).map((check) => (
                <div
                  key={check.id}
                  className="flex items-center justify-between py-1"
                >
                  <div className="flex items-center gap-3">
                    <HealthIndicator isHealthy={check.isHealthy} size="sm" />
                    <span className="text-sm text-text-primary font-mono uppercase">
                      {check.checkType}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-text-muted font-mono">
                    {check.responseTimeMs !== null && (
                      <span>{check.responseTimeMs}ms</span>
                    )}
                    <span>{formatTime(check.createdAt)}</span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Recent Attacks */}
        <Card>
          <CardHeader>
            <span className="font-semibold text-text-primary">
              最近の攻撃履歴
            </span>
          </CardHeader>
          <CardContent className="space-y-3">
            {!dashboard?.recentAttacks?.length ? (
              <p className="text-text-muted text-sm">攻撃履歴なし</p>
            ) : (
              dashboard.recentAttacks.slice(0, 8).map((atk: AttackLog) => (
                <div
                  key={atk.id}
                  className="flex items-center justify-between py-1 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        atk.success ? 'text-hn-success' : 'text-hn-error'
                      }
                    >
                      {atk.success ? '+' : '-'}
                    </span>
                    <span className="text-text-primary font-mono">
                      {atk.attackSlug}
                    </span>
                  </div>
                  <span className="text-text-muted font-mono text-xs">
                    {formatTime(atk.createdAt)}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* URL Settings */}
      <Card>
        <CardHeader>
          <span className="font-semibold text-text-primary">URL 設定</span>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Website URL"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://your-team-site.example.com"
            />
            <Input
              label="API URL"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://your-team-api.example.com"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSaveUrls}
            loading={saving}
          >
            保存
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
