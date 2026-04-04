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
import { useI18n } from '@/lib/i18n';
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
  const { t, locale } = useI18n();
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
            <Box>{t('gameday.selectTeam')}</Box>
            <Link href={`/events/${eventId}`}>{t('gameday.backToEvent')}</Link>
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
            <Button onClick={fetchData}>{t('common.retry')}</Button>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString(locale === 'ja' ? 'ja-JP' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const latestWebsite = healthChecks.find((c) => c.checkType === 'website');
  const latestApi = healthChecks.find((c) => c.checkType === 'api');

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t('gameday.headquartersDescription')}>
        {t('gameday.headquarters')}
      </Header>

      {healthChecks.length > 0 ? (
        <ColumnLayout columns={2}>
          <Container
            header={<Header variant="h3">{t('gameday.website')}</Header>}
          >
            <SpaceBetween size="s">
              {latestWebsite ? (
                <StatusIndicator
                  type={latestWebsite.isHealthy ? 'success' : 'error'}
                >
                  {latestWebsite.isHealthy
                    ? t('gameday.healthy')
                    : t('gameday.unhealthy')}
                </StatusIndicator>
              ) : (
                <StatusIndicator type="warning">
                  {t('gameday.unchecked')}
                </StatusIndicator>
              )}
              {latestWebsite?.responseTimeMs != null ? (
                <Box variant="small">{latestWebsite.responseTimeMs}ms</Box>
              ) : null}
            </SpaceBetween>
          </Container>
          <Container header={<Header variant="h3">{t('gameday.api')}</Header>}>
            <SpaceBetween size="s">
              {latestApi ? (
                <StatusIndicator
                  type={latestApi.isHealthy ? 'success' : 'error'}
                >
                  {latestApi.isHealthy
                    ? t('gameday.healthy')
                    : t('gameday.unhealthy')}
                </StatusIndicator>
              ) : (
                <StatusIndicator type="warning">
                  {t('gameday.unchecked')}
                </StatusIndicator>
              )}
              {latestApi?.responseTimeMs != null ? (
                <Box variant="small">{latestApi.responseTimeMs}ms</Box>
              ) : null}
            </SpaceBetween>
          </Container>
        </ColumnLayout>
      ) : null}

      <ColumnLayout columns={2}>
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
                  {c.isHealthy ? t('gameday.healthy') : t('gameday.unhealthy')}
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
              header: t('gameday.time'),
              cell: (c) => formatTime(c.createdAt),
            },
          ]}
          items={healthChecks.slice(0, 10)}
          loadingText={t('common.loading')}
          header={<Header>{t('gameday.healthChecks')}</Header>}
          empty={t('common.noData')}
          sortingDisabled
        />

        <Table
          columnDefinitions={[
            {
              id: 'status',
              header: '',
              cell: (atk: AttackLog) => (
                <StatusIndicator type={atk.success ? 'success' : 'error'}>
                  {atk.success ? t('gameday.success') : t('gameday.failed')}
                </StatusIndicator>
              ),
              width: 100,
            },
            {
              id: 'attack',
              header: t('gameday.attackName'),
              cell: (atk: AttackLog) => (
                <Box variant="code">{atk.attackSlug}</Box>
              ),
            },
            {
              id: 'time',
              header: t('gameday.time'),
              cell: (atk: AttackLog) => formatTime(atk.createdAt),
            },
          ]}
          items={dashboard?.recentAttacks?.slice(0, 8) ?? []}
          loadingText={t('common.loading')}
          header={<Header>{t('gameday.recentAttacks')}</Header>}
          empty={t('gameday.noAttackHistory')}
          sortingDisabled
        />
      </ColumnLayout>

      <Container header={<Header>{t('gameday.urlSettings')}</Header>}>
        <SpaceBetween size="l">
          <ColumnLayout columns={2}>
            <FormField label={t('gameday.websiteUrl')}>
              <Input
                value={websiteUrl}
                onChange={({ detail }) => setWebsiteUrl(detail.value)}
                placeholder="https://your-team-site.example.com"
              />
            </FormField>
            <FormField label={t('gameday.apiUrl')}>
              <Input
                value={apiUrl}
                onChange={({ detail }) => setApiUrl(detail.value)}
                placeholder="https://your-team-api.example.com"
              />
            </FormField>
          </ColumnLayout>
          <Button variant="primary" onClick={handleSaveUrls} loading={saving}>
            {t('common.save')}
          </Button>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
