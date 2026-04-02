/**
 * Profile Badges Page
 *
 * バッジ一覧ページ
 */

'use client';

import '@cloudscape-design/global-styles/index.css';
import CloudscapeBox from '@cloudscape-design/components/box';
import CloudscapeCards from '@cloudscape-design/components/cards';
import CloudscapeContainer from '@cloudscape-design/components/container';
import CloudscapeHeader from '@cloudscape-design/components/header';
import CloudscapeLink from '@cloudscape-design/components/link';
import CloudscapeSpaceBetween from '@cloudscape-design/components/space-between';
import CloudscapeSpinner from '@cloudscape-design/components/spinner';
import { useEffect, useState } from 'react';
import { Header } from '../../../components/layout';
import { getMyBadges } from '../../../lib/api/profile';
import type { Badge } from '../../../lib/api/types';

export default function BadgesPage() {
  const [badges, setBadges] = useState<Badge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMyBadges()
      .then((d) => setBadges(d.badges))
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

            <CloudscapeHeader variant="h1">バッジ</CloudscapeHeader>

            {loading ? (
              <CloudscapeBox textAlign="center" padding="xl">
                <CloudscapeSpinner size="large" />
              </CloudscapeBox>
            ) : (
              <CloudscapeContainer>
                <CloudscapeCards
                  cardDefinition={{
                    header: (b) => b.name,
                    sections: [
                      {
                        id: 'description',
                        content: (b) => b.description,
                      },
                      {
                        id: 'date',
                        header: '取得日',
                        content: (b) =>
                          new Date(b.earnedAt).toLocaleDateString('ja-JP'),
                      },
                    ],
                  }}
                  cardsPerRow={[{ cards: 1 }, { minWidth: 400, cards: 2 }]}
                  items={badges}
                  empty={
                    <CloudscapeBox
                      textAlign="center"
                      color="inherit"
                      padding="m"
                    >
                      まだバッジを獲得していません
                    </CloudscapeBox>
                  }
                  header={
                    <CloudscapeHeader>
                      獲得バッジ ({badges.length}個)
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
