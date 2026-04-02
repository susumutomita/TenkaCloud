/**
 * Profile Page
 *
 * 参加者プロフィールページ
 */

'use client';

import '@cloudscape-design/global-styles/index.css';
import CloudscapeBox from '@cloudscape-design/components/box';
import CloudscapeColumnLayout from '@cloudscape-design/components/column-layout';
import CloudscapeContainer from '@cloudscape-design/components/container';
import CloudscapeHeader from '@cloudscape-design/components/header';
import CloudscapeKeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import CloudscapeLink from '@cloudscape-design/components/link';
import CloudscapeSpaceBetween from '@cloudscape-design/components/space-between';
import CloudscapeSpinner from '@cloudscape-design/components/spinner';
import { useEffect, useState } from 'react';
import { Header } from '../../components/layout';
import { getMyProfile } from '../../lib/api/profile';
import type { ParticipantProfile } from '../../lib/api/types';

export default function ProfilePage() {
  const [profile, setProfile] = useState<ParticipantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyProfile()
      .then(setProfile)
      .catch((e) =>
        setError(e instanceof Error ? e.message : '読み込みに失敗しました')
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <CloudscapeSpaceBetween size="l">
            <CloudscapeHeader variant="h1">プロフィール</CloudscapeHeader>

            {loading && (
              <CloudscapeBox textAlign="center" padding="xl">
                <CloudscapeSpinner size="large" />
              </CloudscapeBox>
            )}

            {error && (
              <CloudscapeContainer>
                <CloudscapeBox color="text-status-error">{error}</CloudscapeBox>
              </CloudscapeContainer>
            )}

            {!loading && !error && (
              <CloudscapeSpaceBetween size="l">
                <CloudscapeContainer
                  header={
                    <CloudscapeHeader variant="h2">
                      {profile?.name ?? 'ユーザー'}
                    </CloudscapeHeader>
                  }
                >
                  <CloudscapeKeyValuePairs
                    columns={2}
                    items={[
                      { label: 'メールアドレス', value: profile?.email ?? '-' },
                      {
                        label: '現在の順位',
                        value: profile?.rank ? `${profile.rank}位` : '-',
                      },
                      {
                        label: '参加イベント数',
                        value: String(profile?.totalEventsParticipated ?? 0),
                      },
                      {
                        label: '合計スコア',
                        value: `${(profile?.totalScore ?? 0).toLocaleString()} pts`,
                      },
                    ]}
                  />
                </CloudscapeContainer>

                <CloudscapeContainer
                  header={
                    <CloudscapeHeader variant="h2">メニュー</CloudscapeHeader>
                  }
                >
                  <CloudscapeColumnLayout columns={2}>
                    <CloudscapeLink
                      href="/profile/history"
                      fontSize="heading-s"
                    >
                      参加履歴
                    </CloudscapeLink>
                    <CloudscapeLink href="/profile/badges" fontSize="heading-s">
                      バッジ
                    </CloudscapeLink>
                  </CloudscapeColumnLayout>
                </CloudscapeContainer>
              </CloudscapeSpaceBetween>
            )}
          </CloudscapeSpaceBetween>
        </div>
      </main>
    </div>
  );
}
