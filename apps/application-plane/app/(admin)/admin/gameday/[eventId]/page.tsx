/**
 * Admin GameDay Control Panel
 *
 * ゲーム制御 / チーム管理 / 攻撃ログ / 監査
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  getErrorMessage,
  getErrorType,
  Input,
  Select,
  Skeleton,
} from '@/components/ui';
import { HealthIndicator } from '@/components/gameday';
import {
  executeFaultInjection,
  getAttackLogs,
  getGameStatus,
  getTeams,
  registerTeam,
  seedAttacks,
  startAuditor,
  startGame,
  stopAuditor,
  stopGame,
  toggleBlackout,
  toggleScoreWeight,
} from '@/lib/api/gameday-admin';
import { getAttackCatalog } from '@/lib/api/gameday';
import type {
  Attack,
  AttackLog,
  GameState,
  Team,
} from '@/lib/api/gameday-types';

type TabId = 'control' | 'teams' | 'logs' | 'audit' | 'fault-injection';

export default function AdminGamedayControlPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const [activeTab, setActiveTab] = useState<TabId>('control');
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [teams, setTeamsState] = useState<Team[]>([]);
  const [logs, setLogs] = useState<AttackLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Team registration form
  const [newTeamId, setNewTeamId] = useState('');
  const [newTeamName, setNewTeamName] = useState('');
  const [registering, setRegistering] = useState(false);

  // Auditor status
  const [auditorRunning, setAuditorRunning] = useState(false);

  // Fault injection
  const [attacks, setAttacks] = useState<Attack[]>([]);
  const [fiTeamId, setFiTeamId] = useState('');
  const [fiAttackSlug, setFiAttackSlug] = useState('');
  const [fiLoading, setFiLoading] = useState(false);
  const [fiResult, setFiResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [gsData, teamsData, logsData, catalogData] = await Promise.all([
        getGameStatus(eventId),
        getTeams(eventId),
        getAttackLogs(eventId),
        getAttackCatalog(eventId).catch(() => ({ attacks: [] as Attack[] })),
      ]);
      setGameState(gsData);
      setTeamsState(teamsData.teams);
      setLogs(logsData.logs);
      setAttacks(catalogData.attacks);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10000);
    return () => clearInterval(id);
  }, [fetchData]);

  const handleAction = async (action: () => Promise<GameState | unknown>) => {
    setActionLoading(true);
    try {
      await action();
      await fetchData();
    } catch {
      // ignore
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegisterTeam = async () => {
    if (!newTeamId.trim() || !newTeamName.trim()) return;
    setRegistering(true);
    try {
      await registerTeam(eventId, newTeamId.trim(), newTeamName.trim());
      setNewTeamId('');
      setNewTeamName('');
      await fetchData();
    } catch {
      // ignore
    } finally {
      setRegistering(false);
    }
  };

  const handleStartAuditor = async () => {
    setActionLoading(true);
    try {
      await startAuditor(eventId);
      setAuditorRunning(true);
      await fetchData();
    } catch {
      // ignore
    } finally {
      setActionLoading(false);
    }
  };

  const handleStopAuditor = async () => {
    setActionLoading(true);
    try {
      await stopAuditor();
      setAuditorRunning(false);
      await fetchData();
    } catch {
      // ignore
    } finally {
      setActionLoading(false);
    }
  };

  const handleFaultInjection = async () => {
    if (!fiTeamId || !fiAttackSlug) return;
    setFiLoading(true);
    setFiResult(null);
    try {
      const result = await executeFaultInjection(
        eventId,
        fiTeamId,
        fiAttackSlug,
      );
      setFiResult({
        success: result.success,
        message: result.success ? '妨害注入成功' : '妨害注入失敗',
      });
    } catch (err) {
      setFiResult({
        success: false,
        message: err instanceof Error ? err.message : '実行エラー',
      });
    } finally {
      setFiLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
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

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const tabs: { id: TabId; label: string }[] = [
    { id: 'control', label: 'ゲーム制御' },
    { id: 'teams', label: 'チーム管理' },
    { id: 'logs', label: '攻撃ログ' },
    { id: 'audit', label: '監査' },
    { id: 'fault-injection', label: '妨害注入' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center space-x-2 text-sm text-text-muted mb-2 font-mono">
          <Link
            href="/admin/gameday"
            className="hover:text-hn-accent transition-colors"
          >
            GameDay管理
          </Link>
          <span className="text-hn-accent">/</span>
          <span className="text-text-secondary">{eventId}</span>
        </div>
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          コントロールパネル
        </h1>
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <nav className="-mb-px flex space-x-8">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === tab.id
                  ? 'border-hn-accent text-hn-accent'
                  : 'border-transparent text-text-muted hover:text-text-primary hover:border-border'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Game Control Tab */}
      {activeTab === 'control' && gameState && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Game State */}
          <Card>
            <CardHeader>
              <span className="font-semibold text-text-primary">
                ゲーム状態
              </span>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-sm text-text-muted">状態</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`w-3 h-3 rounded-full ${
                        gameState.isRunning
                          ? 'bg-hn-success animate-pulse'
                          : 'bg-text-muted'
                      }`}
                    />
                    <span className="font-medium text-text-primary">
                      {gameState.isRunning ? '稼働中' : '停止'}
                    </span>
                  </div>
                </div>
                <div>
                  <span className="text-sm text-text-muted">時間</span>
                  <div className="font-mono text-text-primary mt-1">
                    {gameState.durationMinutes}分
                  </div>
                </div>
                <div>
                  <span className="text-sm text-text-muted">スコア重み</span>
                  <div className="mt-1">
                    <Badge
                      variant={
                        gameState.scoreWeight === 'high' ? 'warning' : 'default'
                      }
                      badgeStyle="subtle"
                    >
                      {gameState.scoreWeight === 'high' ? '2x' : '通常'}
                    </Badge>
                  </div>
                </div>
                <div>
                  <span className="text-sm text-text-muted">
                    ブラックアウト
                  </span>
                  <div className="mt-1">
                    <Badge
                      variant={gameState.blackout ? 'danger' : 'default'}
                      badgeStyle="subtle"
                    >
                      {gameState.blackout ? 'ON' : 'OFF'}
                    </Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardHeader>
              <span className="font-semibold text-text-primary">操作</span>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {!gameState.isRunning ? (
                  <Button
                    variant="success"
                    onClick={() => handleAction(() => startGame(eventId))}
                    loading={actionLoading}
                  >
                    ゲーム開始
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    onClick={() => handleAction(() => stopGame(eventId))}
                    loading={actionLoading}
                  >
                    ゲーム停止
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => handleAction(() => toggleScoreWeight(eventId))}
                  loading={actionLoading}
                >
                  スコア重み切替
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => handleAction(() => toggleBlackout(eventId))}
                  loading={actionLoading}
                >
                  ブラックアウト切替
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => handleAction(() => seedAttacks(eventId))}
                  loading={actionLoading}
                >
                  攻撃カタログ生成
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Teams Tab */}
      {activeTab === 'teams' && (
        <div className="space-y-6">
          {/* Register Team */}
          <Card>
            <CardHeader>
              <span className="font-semibold text-text-primary">
                チーム登録
              </span>
            </CardHeader>
            <CardContent>
              <div className="flex items-end gap-4">
                <Input
                  label="チーム ID"
                  value={newTeamId}
                  onChange={(e) => setNewTeamId(e.target.value)}
                  placeholder="team-1"
                />
                <Input
                  label="チーム名"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="チーム名"
                />
                <Button
                  variant="primary"
                  onClick={handleRegisterTeam}
                  loading={registering}
                  disabled={
                    !newTeamId.trim() || !newTeamName.trim() || registering
                  }
                >
                  登録
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Team List */}
          <Card>
            <CardHeader>
              <span className="font-semibold text-text-primary">
                登録チーム ({teams.length})
              </span>
            </CardHeader>
            <CardContent>
              {teams.length === 0 ? (
                <p className="text-text-muted text-sm py-4">チームなし</p>
              ) : (
                <div className="space-y-2">
                  {teams.map((team) => (
                    <div
                      key={team.teamId}
                      className="flex items-center justify-between p-3 bg-surface-2 rounded-[var(--radius)]"
                    >
                      <div>
                        <span className="font-medium text-text-primary">
                          {team.teamName}
                        </span>
                        <span className="text-text-muted text-sm ml-3 font-mono">
                          {team.teamId}
                        </span>
                      </div>
                      {team.score !== undefined && (
                        <span className="font-mono text-hn-accent">
                          {team.score} pts
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Attack Logs Tab */}
      {activeTab === 'logs' && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-text-primary">
                攻撃ログ ({logs.length})
              </span>
              <Button variant="ghost" size="sm" onClick={fetchData}>
                更新
              </Button>
            </div>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-2 border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                    時間
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                    攻撃者
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                    防衛者
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                    攻撃
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-text-muted uppercase">
                    結果
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-text-muted uppercase">
                    ダメージ
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-3 text-sm font-mono text-text-muted">
                      {formatTime(log.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary">
                      {log.attackerTeamId}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {log.defenderTeamId}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-text-primary">
                      {log.attackSlug}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge
                        variant={log.success ? 'success' : 'danger'}
                        badgeStyle="subtle"
                        size="sm"
                      >
                        {log.success ? '成功' : '失敗'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-hn-error">
                      {log.damage}
                    </td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-text-muted text-sm"
                    >
                      ログなし
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Audit Tab */}
      {activeTab === 'audit' && (
        <Card>
          <CardHeader>
            <span className="font-semibold text-text-primary">
              監査コントロール
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-text-secondary text-sm">
              ヘルスチェック監査プロセスを制御します。開始すると、全チームのWebサイト/APIの定期的な健全性チェックが実行されます。
            </p>
            <div className="flex items-center gap-3 p-3 bg-surface-2 rounded-[var(--radius)]">
              <HealthIndicator isHealthy={auditorRunning} />
              <span className="text-sm font-medium text-text-primary">
                {auditorRunning ? '監査稼働中' : '監査停止中'}
              </span>
            </div>
            <div className="flex gap-3">
              <Button
                variant="success"
                onClick={handleStartAuditor}
                loading={actionLoading}
              >
                監査開始
              </Button>
              <Button
                variant="danger"
                onClick={handleStopAuditor}
                loading={actionLoading}
              >
                監査停止
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Fault Injection Tab */}
      {activeTab === 'fault-injection' && (
        <Card>
          <CardHeader>
            <span className="font-semibold text-text-primary">
              妨害注入（Fault Injection）
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-text-secondary text-sm">
              管理者として指定チームに対して直接攻撃を実行します。
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Select
                label="対象チーム"
                placeholder="チームを選択"
                options={teams.map((t) => ({
                  value: t.teamId,
                  label: `${t.teamName} (${t.teamId})`,
                }))}
                value={fiTeamId}
                onChange={(e) => setFiTeamId(e.target.value)}
              />
              <Select
                label="攻撃"
                placeholder="攻撃を選択"
                options={attacks.map((a) => ({
                  value: a.slug,
                  label: `${a.name} (${a.slug})`,
                }))}
                value={fiAttackSlug}
                onChange={(e) => setFiAttackSlug(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-4">
              <Button
                variant="danger"
                onClick={handleFaultInjection}
                loading={fiLoading}
                disabled={!fiTeamId || !fiAttackSlug || fiLoading}
              >
                妨害実行
              </Button>
              {fiResult && (
                <Badge
                  variant={fiResult.success ? 'success' : 'danger'}
                  badgeStyle="subtle"
                >
                  {fiResult.message}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Terminal footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> gameday --event={eventId}
        --status={gameState?.isRunning ? 'running' : 'stopped'}
      </div>
    </div>
  );
}
