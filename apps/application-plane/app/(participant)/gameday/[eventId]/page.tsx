/**
 * GameDay Headquarters (司令部)
 *
 * Cloudscape Design System — チーム状態、ヘルスチェック、最近の攻撃履歴、URL設定
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
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
        err instanceof Error ? err : new Error('読み込みに失敗しました'),
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
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (!teamId) {
    return (
      <Container>
        <Box textAlign="center" padding="xl">
          <SpaceBetween size="m">
            <Box>チームを選択してください</Box>
            <Link href={`/events/${eventId}`}>イベントページへ戻る</Link>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Box textAlign="center" padding="xl">
          <SpaceBetween size="m">
            <StatusIndicator type="error">{error.message}</StatusIndicator>
            <Button onClick={fetchData}>再試行</Button>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const latestWebsite = healthChecks.find((c) => c.checkType === 'website');
  const latestApi = healthChecks.find((c) => c.checkType === 'api');

  return (
    <SpaceBetween size="l">
      <Header variant="h1">司令部</Header>

      {/* Application Status Summary */}
      {healthChecks.length > 0 && (
        <ColumnLayout columns={2}>
          <Container header={<Header variant="h3">Website</Header>}>
            <SpaceBetween size="s">
              {latestWebsite ? (
                <StatusIndicator
                  type={latestWebsite.isHealthy ? 'success' : 'error'}
                >
                  {latestWebsite.isHealthy ? '正常' : '異常'}
                </StatusIndicator>
              ) : (
                <StatusIndicator type="warning">未チェック</StatusIndicator>
              )}
              {latestWebsite?.responseTimeMs != null && (
                <Box variant="small">{latestWebsite.responseTimeMs}ms</Box>
              )}
            </SpaceBetween>
          </Container>
          <Container header={<Header variant="h3">API</Header>}>
            <SpaceBetween size="s">
              {latestApi ? (
                <StatusIndicator
                  type={latestApi.isHealthy ? 'success' : 'error'}
                >
                  {latestApi.isHealthy ? '正常' : '異常'}
                </StatusIndicator>
              ) : (
                <StatusIndicator type="warning">未チェック</StatusIndicator>
              )}
              {latestApi?.responseTimeMs != null && (
                <Box variant="small">{latestApi.responseTimeMs}ms</Box>
              )}
            </SpaceBetween>
          </Container>
        </ColumnLayout>
      )}

      <ColumnLayout columns={2}>
        {/* Health Checks Table */}
        <Table
          columnDefinitions={[
            {
              id: 'type',
              header: 'Type',
              cell: (c) => (
                <Box variant="code">{c.checkType.toUpperCase()}</Box>
              ),
            },
            {
              id: 'status',
              header: 'Status',
              cell: (c) => (
                <StatusIndicator type={c.isHealthy ? 'success' : 'error'}>
                  {c.isHealthy ? 'Healthy' : 'Unhealthy'}
                </StatusIndicator>
              ),
            },
            {
              id: 'responseTime',
              header: 'Response',
              cell: (c) =>
                c.responseTimeMs !== null ? `${c.responseTimeMs}ms` : '-',
            },
            {
              id: 'time',
              header: 'Time',
              cell: (c) => formatTime(c.createdAt),
            },
          ]}
          items={healthChecks.slice(0, 10)}
          loadingText="読み込み中"
          header={<Header>ヘルスチェック</Header>}
          empty="データなし"
          sortingDisabled
        />

        {/* Recent Attacks */}
        <Table
          columnDefinitions={[
            {
              id: 'status',
              header: '',
              cell: (atk: AttackLog) => (
                <StatusIndicator type={atk.success ? 'success' : 'error'}>
                  {atk.success ? '成功' : '失敗'}
                </StatusIndicator>
              ),
              width: 100,
            },
            {
              id: 'attack',
              header: 'Attack',
              cell: (atk: AttackLog) => (
                <Box variant="code">{atk.attackSlug}</Box>
              ),
            },
            {
              id: 'time',
              header: 'Time',
              cell: (atk: AttackLog) => formatTime(atk.createdAt),
            },
          ]}
          items={dashboard?.recentAttacks?.slice(0, 8) ?? []}
          loadingText="読み込み中"
          header={<Header>最近の攻撃履歴</Header>}
          empty="攻撃履歴なし"
          sortingDisabled
        />
      </ColumnLayout>

      {/* URL Settings */}
      <Container header={<Header>URL 設定</Header>}>
        <SpaceBetween size="l">
          <ColumnLayout columns={2}>
            <FormField label="Website URL">
              <Input
                value={websiteUrl}
                onChange={({ detail }) => setWebsiteUrl(detail.value)}
                placeholder="https://your-team-site.example.com"
              />
            </FormField>
            <FormField label="API URL">
              <Input
                value={apiUrl}
                onChange={({ detail }) => setApiUrl(detail.value)}
                placeholder="https://your-team-api.example.com"
              />
            </FormField>
          </ColumnLayout>
          <Button variant="primary" onClick={handleSaveUrls} loading={saving}>
            保存
          </Button>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
