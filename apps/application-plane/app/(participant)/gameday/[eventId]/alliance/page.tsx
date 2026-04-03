/**
 * Alliance Page (同盟)
 *
 * Cloudscape Design System — 同盟リクエスト送信、ACTIVE同盟、受信/送信PENDING
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import {
  acceptAlliance,
  breakAlliance,
  getAlliances,
  requestAlliance,
} from '@/lib/api/gameday';
import type { Alliance } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';
import { useI18n } from '@/lib/i18n';

export default function AlliancePage() {
  const { t, locale } = useI18n();
  const { eventId, teamId } = useGamedaySession();
  const [alliances, setAlliances] = useState<Alliance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [teamOptions, setTeamOptions] = useState<SelectProps.Option[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<SelectProps.Option | null>(
    null,
  );
  const [requesting, setRequesting] = useState(false);

  const fetchData = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const data = await getAlliances(eventId, teamId);
      setAlliances(data.alliances);
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
    if (!eventId) return;
    const gamedayApiUrl =
      process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
      'http://localhost:3020/api/gameday';
    fetch(`${gamedayApiUrl}/admin/teams?eventId=${encodeURIComponent(eventId)}`)
      .then((response) => (response.ok ? response.json() : { teams: [] }))
      .then((data) => {
        const options = (data.teams || [])
          .filter((team: { teamId: string }) => team.teamId !== teamId)
          .map((team: { teamId: string; teamName: string }) => ({
            value: team.teamId,
            label: team.teamName,
          }));
        setTeamOptions(options);
      })
      .catch(() => {});
  }, [eventId, teamId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAccept = async (allianceId: string) => {
    if (!eventId || !teamId) return;
    setActionLoading((prev) => ({ ...prev, [allianceId]: true }));
    try {
      await acceptAlliance(allianceId, eventId, teamId);
      await fetchData();
    } catch {
      // ignore
    } finally {
      setActionLoading((prev) => ({ ...prev, [allianceId]: false }));
    }
  };

  const handleBreak = async (allianceId: string) => {
    if (!eventId || !teamId) return;
    setActionLoading((prev) => ({ ...prev, [allianceId]: true }));
    try {
      await breakAlliance(allianceId, eventId, teamId);
      await fetchData();
    } catch {
      // ignore
    } finally {
      setActionLoading((prev) => ({ ...prev, [allianceId]: false }));
    }
  };

  const handleRequest = async () => {
    if (!eventId || !teamId || !selectedTeam?.value) return;
    setRequesting(true);
    try {
      await requestAlliance(eventId, teamId, selectedTeam.value);
      setSelectedTeam(null);
      await fetchData();
    } catch {
      // ignore
    } finally {
      setRequesting(false);
    }
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
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

  const active = alliances.filter((alliance) => alliance.status === 'ACTIVE');
  const pendingIncoming = alliances.filter(
    (alliance) =>
      alliance.status === 'PENDING' && alliance.targetTeamId === teamId,
  );
  const pendingOutgoing = alliances.filter(
    (alliance) =>
      alliance.status === 'PENDING' && alliance.requesterTeamId === teamId,
  );

  const getPartnerTeamId = (alliance: Alliance) =>
    alliance.requesterTeamId === teamId
      ? alliance.targetTeamId
      : alliance.requesterTeamId;

  const formatDate = (timestamp: string) =>
    new Date(timestamp).toLocaleDateString(
      locale === 'ja' ? 'ja-JP' : 'en-US',
      {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      },
    );

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t('gameday.allianceDescription')}>
        {t('gameday.alliances')}
      </Header>

      <Container
        header={<Header variant="h2">{t('gameday.allianceRequest')}</Header>}
      >
        <SpaceBetween direction="horizontal" size="l" alignItems="end">
          <FormField label={t('common.targetTeam')} stretch>
            <Select
              selectedOption={selectedTeam}
              onChange={({ detail }) => setSelectedTeam(detail.selectedOption)}
              options={teamOptions}
              placeholder={t('common.selectTeam')}
              filteringType="auto"
            />
          </FormField>
          <Button
            variant="primary"
            onClick={handleRequest}
            loading={requesting}
            disabled={!selectedTeam || requesting}
          >
            {t('gameday.send')}
          </Button>
        </SpaceBetween>
      </Container>

      <Cards
        header={
          <Header counter={`(${active.length})`}>
            {t('gameday.activeAlliances')}
          </Header>
        }
        items={active}
        cardsPerRow={[
          { cards: 1 },
          { minWidth: 400, cards: 2 },
          { minWidth: 700, cards: 3 },
        ]}
        cardDefinition={{
          header: (alliance) => getPartnerTeamId(alliance),
          sections: [
            {
              id: 'status',
              content: () => (
                <StatusIndicator type="success">
                  {t('gameday.activeBadge')}
                </StatusIndicator>
              ),
            },
            {
              id: 'date',
              header: locale === 'ja' ? '締結日' : 'Joined',
              content: (alliance) => formatDate(alliance.updatedAt),
            },
            {
              id: 'action',
              content: (alliance) => (
                <Button
                  variant="link"
                  loading={actionLoading[alliance.id]}
                  onClick={() => handleBreak(alliance.id)}
                >
                  {t('gameday.break')}
                </Button>
              ),
            },
          ],
        }}
        empty={
          <Box textAlign="center" padding="l" color="text-body-secondary">
            {t('gameday.noAlliances')}
          </Box>
        }
      />

      {pendingIncoming.length > 0 ? (
        <Cards
          header={
            <Header counter={`(${pendingIncoming.length})`}>
              <StatusIndicator type="warning">
                {t('gameday.incomingRequests')}
              </StatusIndicator>
            </Header>
          }
          items={pendingIncoming}
          cardsPerRow={[
            { cards: 1 },
            { minWidth: 400, cards: 2 },
            { minWidth: 700, cards: 3 },
          ]}
          cardDefinition={{
            header: (alliance) => alliance.requesterTeamId,
            sections: [
              {
                id: 'status',
                content: () => (
                  <StatusIndicator type="pending">
                    {t('gameday.pending')}
                  </StatusIndicator>
                ),
              },
              {
                id: 'date',
                header: locale === 'ja' ? '受信日' : 'Received',
                content: (alliance) => formatDate(alliance.createdAt),
              },
              {
                id: 'action',
                content: (alliance) => (
                  <Button
                    variant="primary"
                    loading={actionLoading[alliance.id]}
                    onClick={() => handleAccept(alliance.id)}
                  >
                    {t('gameday.accept')}
                  </Button>
                ),
              },
            ],
          }}
        />
      ) : null}

      {pendingOutgoing.length > 0 ? (
        <Cards
          header={
            <Header counter={`(${pendingOutgoing.length})`}>
              {t('gameday.outgoingRequests')}
            </Header>
          }
          items={pendingOutgoing}
          cardsPerRow={[
            { cards: 1 },
            { minWidth: 400, cards: 2 },
            { minWidth: 700, cards: 3 },
          ]}
          cardDefinition={{
            header: (alliance) => alliance.targetTeamId,
            sections: [
              {
                id: 'status',
                content: () => (
                  <StatusIndicator type="in-progress">
                    {t('gameday.sent')}
                  </StatusIndicator>
                ),
              },
              {
                id: 'date',
                header: locale === 'ja' ? '送信日' : 'Sent',
                content: (alliance) => formatDate(alliance.createdAt),
              },
            ],
          }}
        />
      ) : null}
    </SpaceBetween>
  );
}
