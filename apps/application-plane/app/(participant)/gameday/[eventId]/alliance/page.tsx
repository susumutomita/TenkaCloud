/**
 * Alliance Page (同盟)
 *
 * ACTIVE同盟、受信PENDING、送信PENDING、新規リクエストフォーム
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { AllianceCard } from '@/components/gameday';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  getErrorMessage,
  getErrorType,
  Select,
} from '@/components/ui';
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
    {}
  );
  const [teams, setTeams] = useState<{ value: string; label: string }[]>([]);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [requesting, setRequesting] = useState(false);

  const fetchData = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const data = await getAlliances(eventId, teamId);
      setAlliances(data.alliances);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました')
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId]);

  // Fetch teams
  useEffect(() => {
    if (!eventId) return;
    const GAMEDAY_API_URL =
      process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
      'http://localhost:3020/api/gameday';
    fetch(
      `${GAMEDAY_API_URL}/admin/teams?eventId=${encodeURIComponent(eventId)}`
    )
      .then((r) => (r.ok ? r.json() : { teams: [] }))
      .then((data) => {
        const opts = (data.teams || [])
          .filter((t: { teamId: string }) => t.teamId !== teamId)
          .map((t: { teamId: string; teamName: string }) => ({
            value: t.teamId,
            label: t.teamName,
          }));
        setTeams(opts);
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
    if (!eventId || !teamId || !selectedTeam) return;
    setRequesting(true);
    try {
      await requestAlliance(eventId, teamId, selectedTeam);
      setSelectedTeam('');
      await fetchData();
    } catch {
      // ignore
    } finally {
      setRequesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        message={getErrorMessage(error)}
        type={getErrorType(error)}
        onRetry={fetchData}
      />
    );
  }

  const active = alliances.filter((a) => a.status === 'ACTIVE');
  const pendingIncoming = alliances.filter(
    (a) => a.status === 'PENDING' && a.targetTeamId === teamId
  );
  const pendingOutgoing = alliances.filter(
    (a) => a.status === 'PENDING' && a.requesterTeamId === teamId
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
        <span className="text-hn-accent font-mono">&gt;_</span>
        同盟
      </h1>

      {/* New Alliance Request */}
      <Card>
        <CardHeader>
          <span className="font-semibold text-text-primary">
            同盟リクエスト送信
          </span>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4">
            <Select
              options={teams}
              placeholder="チームを選択"
              value={selectedTeam}
              onChange={(e) => setSelectedTeam(e.target.value)}
              label="対象チーム"
            />
            <Button
              variant="primary"
              size="md"
              onClick={handleRequest}
              loading={requesting}
              disabled={!selectedTeam || requesting}
            >
              送信
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Active Alliances */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-text-primary">
          アクティブ ({active.length})
        </h2>
        {active.length === 0 ? (
          <p className="text-text-muted text-sm">同盟なし</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {active.map((a) => (
              <AllianceCard
                key={a.id}
                alliance={a}
                myTeamId={teamId}
                loading={actionLoading[a.id]}
                onBreak={() => handleBreak(a.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pending Incoming */}
      {pendingIncoming.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-hn-warning">
            受信リクエスト ({pendingIncoming.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pendingIncoming.map((a) => (
              <AllianceCard
                key={a.id}
                alliance={a}
                myTeamId={teamId}
                loading={actionLoading[a.id]}
                onAccept={() => handleAccept(a.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Pending Outgoing */}
      {pendingOutgoing.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-text-secondary">
            送信済みリクエスト ({pendingOutgoing.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pendingOutgoing.map((a) => (
              <AllianceCard key={a.id} alliance={a} myTeamId={teamId} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
