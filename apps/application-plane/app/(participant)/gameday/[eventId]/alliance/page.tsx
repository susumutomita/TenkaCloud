/**
 * Alliance Page (同盟)
 *
 * Cloudscape Design System — 同盟リクエスト送信、ACTIVE同盟、受信/送信PENDING
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
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

export default function AlliancePage() {
  const { eventId, teamId } = useGamedaySession();
  const [alliances, setAlliances] = useState<Alliance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [teamOptions, setTeamOptions] = useState<SelectProps.Option[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<SelectProps.Option | null>(
    null
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
    const GAMEDAY_API_URL =
      process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
      'http://localhost:3020/api/gameday';
    fetch(
      `${GAMEDAY_API_URL}/admin/teams?eventId=${encodeURIComponent(eventId)}`,
    )
      .then((r) => (r.ok ? r.json() : { teams: [] }))
      .then((data) => {
        const opts = (data.teams || [])
          .filter((t: { teamId: string }) => t.teamId !== teamId)
          .map((t: { teamId: string; teamName: string }) => ({
            value: t.teamId,
            label: t.teamName,
          }));
        setTeamOptions(opts);
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
            <Button onClick={fetchData}>再試行</Button>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  const active = alliances.filter((a) => a.status === 'ACTIVE');
  const pendingIncoming = alliances.filter(
    (a) => a.status === 'PENDING' && a.targetTeamId === teamId,
  );
  const pendingOutgoing = alliances.filter(
    (a) => a.status === 'PENDING' && a.requesterTeamId === teamId,
  );

  const getPartnerTeamId = (a: Alliance) =>
    a.requesterTeamId === teamId ? a.targetTeamId : a.requesterTeamId;

  const formatDate = (ts: string) =>
    new Date(ts).toLocaleDateString('ja-JP', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <SpaceBetween size="l">
      <Header variant="h1">同盟</Header>

      {/* New Alliance Request */}
      <Container header={<Header variant="h2">同盟リクエスト送信</Header>}>
        <SpaceBetween direction="horizontal" size="l" alignItems="end">
          <FormField label="対象チーム" stretch>
            <Select
              selectedOption={selectedTeam}
              onChange={({ detail }) => setSelectedTeam(detail.selectedOption)}
              options={teamOptions}
              placeholder="チームを選択"
              filteringType="auto"
            />
          </FormField>
          <Button
            variant="primary"
            onClick={handleRequest}
            loading={requesting}
            disabled={!selectedTeam || requesting}
          >
            送信
          </Button>
        </SpaceBetween>
      </Container>

      {/* Active Alliances */}
      <Cards
        header={<Header counter={`(${active.length})`}>アクティブ</Header>}
        items={active}
        cardsPerRow={[
          { cards: 1 },
          { minWidth: 400, cards: 2 },
          { minWidth: 700, cards: 3 },
        ]}
        cardDefinition={{
          header: (a) => getPartnerTeamId(a),
          sections: [
            {
              id: 'status',
              content: () => (
                <StatusIndicator type="success">ACTIVE</StatusIndicator>
              ),
            },
            {
              id: 'date',
              header: '締結日',
              content: (a) => formatDate(a.updatedAt),
            },
            {
              id: 'action',
              content: (a) => (
                <Button
                  variant="link"
                  loading={actionLoading[a.id]}
                  onClick={() => handleBreak(a.id)}
                >
                  同盟を破棄
                </Button>
              ),
            },
          ],
        }}
        empty={
          <Box textAlign="center" padding="l" color="text-body-secondary">
            同盟なし
          </Box>
        }
      />

      {/* Pending Incoming */}
      {pendingIncoming.length > 0 && (
        <Cards
          header={
            <Header counter={`(${pendingIncoming.length})`}>
              <StatusIndicator type="warning">受信リクエスト</StatusIndicator>
            </Header>
          }
          items={pendingIncoming}
          cardsPerRow={[
            { cards: 1 },
            { minWidth: 400, cards: 2 },
            { minWidth: 700, cards: 3 },
          ]}
          cardDefinition={{
            header: (a) => a.requesterTeamId,
            sections: [
              {
                id: 'status',
                content: () => (
                  <StatusIndicator type="pending">PENDING</StatusIndicator>
                ),
              },
              {
                id: 'date',
                header: '受信日',
                content: (a) => formatDate(a.createdAt),
              },
              {
                id: 'action',
                content: (a) => (
                  <Button
                    variant="primary"
                    loading={actionLoading[a.id]}
                    onClick={() => handleAccept(a.id)}
                  >
                    承認
                  </Button>
                ),
              },
            ],
          }}
        />
      )}

      {/* Pending Outgoing */}
      {pendingOutgoing.length > 0 && (
        <Cards
          header={
            <Header counter={`(${pendingOutgoing.length})`}>
              送信済みリクエスト
            </Header>
          }
          items={pendingOutgoing}
          cardsPerRow={[
            { cards: 1 },
            { minWidth: 400, cards: 2 },
            { minWidth: 700, cards: 3 },
          ]}
          cardDefinition={{
            header: (a) => a.targetTeamId,
            sections: [
              {
                id: 'status',
                content: () => (
                  <StatusIndicator type="in-progress">送信済み</StatusIndicator>
                ),
              },
              {
                id: 'date',
                header: '送信日',
                content: (a) => formatDate(a.createdAt),
              },
            ],
          }}
        />
      )}
    </SpaceBetween>
  );
}
