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
import { Header } from '../../../components/layout';
import { getEventHistory } from '../../../lib/api/profile';
import type { ParticipantEventSummary } from '../../../lib/api/types';

export default function HistoryPage() {
  const [events, setEvents] = useState<ParticipantEventSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getEventHistory({ limit: 50 })
      .then((d) => setEvents(d.events))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <CloudscapeSpaceBetween size="l">
            <CloudscapeBox>
              <CloudscapeLink href="/profile">← プロフィール</CloudscapeLink>
            </CloudscapeBox>

            <CloudscapeHeader variant="h1">参加履歴</CloudscapeHeader>

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
                      header: 'イベント',
                      cell: (e) => e.eventName,
                    },
                    {
                      id: 'date',
                      header: '参加日',
                      cell: (e) =>
                        new Date(e.participatedAt).toLocaleDateString('ja-JP'),
                    },
                    {
                      id: 'rank',
                      header: '順位',
                      cell: (e) =>
                        e.finalRank
                          ? `${e.finalRank} / ${e.totalParticipants}`
                          : '-',
                    },
                    {
                      id: 'score',
                      header: 'スコア',
                      cell: (e) => `${e.score.toLocaleString()} pts`,
                    },
                  ]}
                  items={events}
                  empty={
                    <CloudscapeBox
                      textAlign="center"
                      color="inherit"
                      padding="m"
                    >
                      まだイベントに参加していません
                    </CloudscapeBox>
                  }
                  header={
                    <CloudscapeHeader>
                      イベント履歴 ({events.length}件)
                    </CloudscapeHeader>
                  }
                />
              </CloudscapeContainer>
            )}
          </CloudscapeSpaceBetween>
        </div>
      </main>
    </div>
  );
}
