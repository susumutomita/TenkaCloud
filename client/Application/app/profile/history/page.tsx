/**
 * Profile History Page
 *
 * 参加履歴ページ（ページネーション対応）
 */

'use client';

import '@cloudscape-design/global-styles/index.css';
import CloudscapeBox from '@cloudscape-design/components/box';
import CloudscapeContainer from '@cloudscape-design/components/container';
import CloudscapeHeader from '@cloudscape-design/components/header';
import CloudscapeLink from '@cloudscape-design/components/link';
import CloudscapePagination from '@cloudscape-design/components/pagination';
import CloudscapeSpaceBetween from '@cloudscape-design/components/space-between';
import CloudscapeSpinner from '@cloudscape-design/components/spinner';
import CloudscapeTable from '@cloudscape-design/components/table';
import { useCallback, useEffect, useState } from 'react';
import { PageLayout } from '../../../components/layout';
import { useI18n } from '../../../lib/i18n';
import { getEventHistory } from '../../../lib/api/profile';
import type { ParticipantEventSummary } from '../../../lib/api/types';

const PAGE_SIZE = 20;

export default function HistoryPage() {
  const { t } = useI18n();
  const [events, setEvents] = useState<ParticipantEventSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  const fetchHistory = useCallback(async (page: number) => {
    setLoading(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const d = await getEventHistory({ limit: PAGE_SIZE, offset });
      setEvents(d.events);
      setTotal(d.total);
    } catch {
      // Silently handle - empty state will show
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory(currentPage);
  }, [fetchHistory, currentPage]);

  const pagesCount = Math.ceil(total / PAGE_SIZE);

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
                  {t('profile.history')} ({total})
                </CloudscapeHeader>
              }
              pagination={
                pagesCount > 1 ? (
                  <CloudscapePagination
                    currentPageIndex={currentPage}
                    pagesCount={pagesCount}
                    onChange={({ detail }) =>
                      setCurrentPage(detail.currentPageIndex)
                    }
                  />
                ) : undefined
              }
            />
          </CloudscapeContainer>
        )}
      </CloudscapeSpaceBetween>
    </PageLayout>
  );
}
