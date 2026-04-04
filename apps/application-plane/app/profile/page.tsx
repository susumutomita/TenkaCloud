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
import { PageLayout } from '../../components/layout';
import { useI18n } from '../../lib/i18n';
import { getMyProfile } from '../../lib/api/profile';
import type { ParticipantProfile } from '../../lib/api/types';

export default function ProfilePage() {
  const { t } = useI18n();
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
    <PageLayout maxWidth="3xl">
      <CloudscapeSpaceBetween size="l">
        <CloudscapeHeader variant="h1">{t('profile.title')}</CloudscapeHeader>

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
                  {
                    label: t('profile.email'),
                    value: profile?.email ?? '-',
                  },
                  {
                    label: t('profile.rank'),
                    value: profile?.rank
                      ? `${profile.rank}${t('profile.rankSuffix')}`
                      : '-',
                  },
                  {
                    label: t('profile.eventsParticipated'),
                    value: String(profile?.totalEventsParticipated ?? 0),
                  },
                  {
                    label: t('profile.totalScore'),
                    value: `${(profile?.totalScore ?? 0).toLocaleString()} pts`,
                  },
                ]}
              />
            </CloudscapeContainer>

            <CloudscapeContainer
              header={
                <CloudscapeHeader variant="h2">
                  {t('profile.menu')}
                </CloudscapeHeader>
              }
            >
              <CloudscapeColumnLayout columns={2}>
                <CloudscapeLink href="/profile/history" fontSize="heading-s">
                  {t('profile.history')}
                </CloudscapeLink>
                <CloudscapeLink href="/profile/badges" fontSize="heading-s">
                  {t('profile.badges')}
                </CloudscapeLink>
              </CloudscapeColumnLayout>
            </CloudscapeContainer>
          </CloudscapeSpaceBetween>
        )}
      </CloudscapeSpaceBetween>
    </PageLayout>
  );
}
