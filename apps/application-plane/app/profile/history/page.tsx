/**
 * Profile History Page
 *
 * 参加履歴ページ
 */

'use client';

import '@cloudscape-design/global-styles/index.css';
import CloudscapeBox from '@cloudscape-design/components/box';
import CloudscapeContainer from '@cloudscape-design/components/container';
import CloudscapeHeader from '@cloudscape-design/components/header';
import CloudscapeLink from '@cloudscape-design/components/link';
import CloudscapeSpaceBetween from '@cloudscape-design/components/space-between';
import CloudscapeSpinner from '@cloudscape-design/components/spinner';
import CloudscapeTable from '@cloudscape-design/components/table';
import { useEffect, useState } from 'react';
import { PageLayout } from '../../../components/layout';
import { useI18n } from '../../../lib/i18n';
import { getEventHistory } from '../../../lib/api/profile';
import type { ParticipantEventSummary } from '../../../lib/api/types';

export default function HistoryPage() {
  const { t } = useI18n();
  const [events, setEvents] = useState<ParticipantEventSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getEventHistory({ limit: 50 })
      .then((d) => setEvents(d.events))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <PageLayout maxWidth="3xl">
      <CloudscapeSpaceBetween size="l">
        <CloudscapeBox>
          <CloudscapeLink href="/profile">
            {t('profile.backToProfile')}
          </CloudscapeLink>
        </CloudscapeBox>

        <CloudscapeHeader variant="h1">{t('profile.history')}</CloudscapeHeader>

        {loading ? (
          <CloudscapeBox textAlign="center" padding="xl">
            <CloudscapeSpinner size="large" />
          </CloudscapeBox>
        ) : (
          <CloudscapeContainer>
            <CloudscapeTable
              columnDefinitions={[
                {
                  id: 'event',
                  header: t('profile.event'),
                  cell: (e) => e.eventName,
                },
                {
                  id: 'date',
                  header: t('profile.date'),
                  cell: (e) => new Date(e.participatedAt).toLocaleDateString(),
                },
                {
                  id: 'rank',
                  header: t('leaderboard.rank'),
                  cell: (e) =>
                    e.finalRank
                      ? `${e.finalRank} / ${e.totalParticipants}`
                      : '-',
                },
                {
                  id: 'score',
                  header: t('profile.score'),
                  cell: (e) => `${e.score.toLocaleString()} pts`,
                },
              ]}
              items={events}
              empty={
                <CloudscapeBox textAlign="center" color="inherit" padding="m">
                  {t('profile.historyEmpty')}
                </CloudscapeBox>
              }
              header={
                <CloudscapeHeader>
                  {t('profile.history')} ({events.length})
                </CloudscapeHeader>
              }
            />
          </CloudscapeContainer>
        )}
      </CloudscapeSpaceBetween>
    </PageLayout>
  );
}
