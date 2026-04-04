/**
 * Admin GameDay Control Panel
 *
 * Cloudscape Design System - ゲーム制御 / チーム管理 / 攻撃ログ / 監査
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import type { SelectProps } from '@cloudscape-design/components/select';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import Toggle from '@cloudscape-design/components/toggle';
import '@cloudscape-design/global-styles/index.css';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getAttackCatalog } from '@/lib/api/gameday';
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
import type {
  Attack,
  AttackLog,
  GameState,
  Team,
} from '@/lib/api/gameday-types';

export default function AdminGamedayControlPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [teams, setTeamsState] = useState<Team[]>([]);
  const [logs, setLogs] = useState<AttackLog[]>([]);
  const [attacks, setAttacks] = useState<Attack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const [durationMinutes, setDurationMinutes] = useState('60');

  const [newTeamId, setNewTeamId] = useState('');
  const [newTeamName, setNewTeamName] = useState('');
  const [newWebsiteUrl, setNewWebsiteUrl] = useState('');
  const [newApiUrl, setNewApiUrl] = useState('');
  const [registering, setRegistering] = useState(false);

  const [auditorRunning, setAuditorRunning] = useState(false);

  const [fiTeamId, setFiTeamId] = useState<SelectProps.Option | null>(null);
  const [fiAttackSlug, setFiAttackSlug] = useState<SelectProps.Option | null>(
    null,
  );
  const [fiLoading, setFiLoading] = useState(false);
  const [fiResult, setFiResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10000);
    return () => clearInterval(id);
  }, [fetchData]);

  useEffect(() => {
    if (gameState?.isRunning && gameState.startedAt) {
      const startTime = new Date(gameState.startedAt).getTime();
      const updateTimer = () => {
        const now = Date.now();
        setElapsedSeconds(Math.floor((now - startTime) / 1000));
      };
      updateTimer();
      timerRef.current = setInterval(updateTimer, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
    setElapsedSeconds(0);
    if (timerRef.current) clearInterval(timerRef.current);
    return undefined;
  }, [gameState?.isRunning, gameState?.startedAt]);

  const handleAction = async (action: () => Promise<GameState | unknown>) => {
    setActionLoading(true);
    try {
      await action();
      await fetchData();
    } catch {
      /* ignore */
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegisterTeam = async () => {
    if (!newTeamId.trim() || !newTeamName.trim()) return;
    setRegistering(true);
    try {
      await registerTeam(eventId, newTeamId.trim(), newTeamName.trim(), {
        websiteUrl: newWebsiteUrl.trim() || undefined,
        apiUrl: newApiUrl.trim() || undefined,
      });
      setNewTeamId('');
      setNewTeamName('');
      setNewWebsiteUrl('');
      setNewApiUrl('');
      await fetchData();
    } catch {
      /* ignore */
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
      /* ignore */
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
      /* ignore */
    } finally {
      setActionLoading(false);
    }
  };

  const handleFaultInjection = async () => {
    if (!fiTeamId?.value || !fiAttackSlug?.value) return;
    setFiLoading(true);
    setFiResult(null);
    try {
      const result = await executeFaultInjection(
        eventId,
        fiTeamId.value,
        fiAttackSlug.value,
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

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const formatTimer = (totalSeconds: number) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const getRemainingSeconds = () => {
    if (!gameState) return 0;
    const totalSeconds = gameState.durationMinutes * 60;
    return Math.max(0, totalSeconds - elapsedSeconds);
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner size="large" />
      </Box>
    );
  }

  if (error) {
    return (
      <Box textAlign="center" padding="l">
        <SpaceBetween size="m">
          <StatusIndicator type="error">{error}</StatusIndicator>
          <Button onClick={fetchData}>再読み込み</Button>
        </SpaceBetween>
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={`イベント ID: ${eventId}`}>
        GameDay コントロールパネル
      </Header>
      <Tabs
        tabs={[
          {
            label: 'ゲーム制御',
            id: 'control',
            content: (
              <SpaceBetween size="l">
                <Container
                  header={
                    <Header
                      variant="h2"
                      actions={
                        <Button
                          iconName="refresh"
                          variant="icon"
                          onClick={fetchData}
                          ariaLabel="更新"
                        />
                      }
                    >
                      ゲーム制御
                    </Header>
                  }
                >
                  <SpaceBetween size="l">
                    <ColumnLayout columns={4} variant="text-grid">
                      <div>
                        <Box variant="awsui-key-label">状態</Box>
                        <StatusIndicator
                          type={gameState?.isRunning ? 'success' : 'stopped'}
                        >
                          {gameState?.isRunning ? '稼働中' : '停止'}
                        </StatusIndicator>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">設定時間</Box>
                        <Box>{gameState?.durationMinutes ?? 0}分</Box>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">経過時間</Box>
                        <Box fontWeight="bold">
                          {gameState?.isRunning
                            ? formatTimer(elapsedSeconds)
                            : '--:--:--'}
                        </Box>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">残り時間</Box>
                        <Box fontWeight="bold">
                          {gameState?.isRunning
                            ? formatTimer(getRemainingSeconds())
                            : '--:--:--'}
                        </Box>
                      </div>
                    </ColumnLayout>
                    <SpaceBetween direction="horizontal" size="xs">
                      {!gameState?.isRunning ? (
                        <>
                          <FormField label="ゲーム時間（分）">
                            <Input
                              type="number"
                              value={durationMinutes}
                              onChange={({ detail }) =>
                                setDurationMinutes(detail.value)
                              }
                              inputMode="numeric"
                            />
                          </FormField>
                          <Box padding={{ top: 'l' }}>
                            <Button
                              variant="primary"
                              loading={actionLoading}
                              onClick={() =>
                                handleAction(() =>
                                  startGame(
                                    eventId,
                                    Number(durationMinutes) || undefined,
                                  ),
                                )
                              }
                            >
                              ゲーム開始
                            </Button>
                          </Box>
                        </>
                      ) : (
                        <Button
                          variant="normal"
                          loading={actionLoading}
                          onClick={() => handleAction(() => stopGame(eventId))}
                          iconName="close"
                        >
                          ゲーム停止
                        </Button>
                      )}
                    </SpaceBetween>
                  </SpaceBetween>
                </Container>
                <Container
                  header={<Header variant="h2">スコア・表示制御</Header>}
                >
                  <ColumnLayout columns={2}>
                    <SpaceBetween size="s">
                      <Box variant="awsui-key-label">スコア重み</Box>
                      <Toggle
                        checked={gameState?.scoreWeight === 'high'}
                        onChange={() =>
                          handleAction(() => toggleScoreWeight(eventId))
                        }
                        disabled={actionLoading}
                      >
                        {gameState?.scoreWeight === 'high' ? (
                          <Badge color="blue">2x</Badge>
                        ) : (
                          '通常'
                        )}
                      </Toggle>
                    </SpaceBetween>
                    <SpaceBetween size="s">
                      <Box variant="awsui-key-label">ブラックアウト</Box>
                      <Toggle
                        checked={gameState?.blackout ?? false}
                        onChange={() =>
                          handleAction(() => toggleBlackout(eventId))
                        }
                        disabled={actionLoading}
                      >
                        {gameState?.blackout ? (
                          <Badge color="red">ON</Badge>
                        ) : (
                          'OFF'
                        )}
                      </Toggle>
                    </SpaceBetween>
                  </ColumnLayout>
                </Container>
              </SpaceBetween>
            ),
          },
          {
            label: 'チーム管理',
            id: 'teams',
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">チーム登録</Header>}>
                  <SpaceBetween size="m">
                    <ColumnLayout columns={2}>
                      <FormField label="チーム ID">
                        <Input
                          value={newTeamId}
                          onChange={({ detail }) => setNewTeamId(detail.value)}
                          placeholder="team-1"
                        />
                      </FormField>
                      <FormField label="チーム名">
                        <Input
                          value={newTeamName}
                          onChange={({ detail }) =>
                            setNewTeamName(detail.value)
                          }
                          placeholder="チーム名"
                        />
                      </FormField>
                      <FormField label="ウェブサイト URL">
                        <Input
                          value={newWebsiteUrl}
                          onChange={({ detail }) =>
                            setNewWebsiteUrl(detail.value)
                          }
                          placeholder="https://example.com"
                          type="url"
                        />
                      </FormField>
                      <FormField label="API URL">
                        <Input
                          value={newApiUrl}
                          onChange={({ detail }) => setNewApiUrl(detail.value)}
                          placeholder="https://api.example.com"
                          type="url"
                        />
                      </FormField>
                    </ColumnLayout>
                    <Button
                      variant="primary"
                      onClick={handleRegisterTeam}
                      loading={registering}
                      disabled={
                        !newTeamId.trim() || !newTeamName.trim() || registering
                      }
                    >
                      チーム登録
                    </Button>
                  </SpaceBetween>
                </Container>
                <Table
                  header={
                    <Header counter={`(${teams.length})`}>登録チーム</Header>
                  }
                  items={teams}
                  empty={
                    <Box textAlign="center" padding="l">
                      <Box variant="p" color="text-body-secondary">
                        チームが登録されていません
                      </Box>
                    </Box>
                  }
                  columnDefinitions={[
                    {
                      id: 'teamName',
                      header: 'チーム名',
                      cell: (item) => item.teamName,
                      sortingField: 'teamName',
                    },
                    {
                      id: 'teamId',
                      header: 'チーム ID',
                      cell: (item) => item.teamId,
                    },
                    {
                      id: 'websiteUrl',
                      header: 'ウェブサイト URL',
                      cell: (item) => item.websiteUrl ?? '-',
                    },
                    {
                      id: 'apiUrl',
                      header: 'API URL',
                      cell: (item) => item.apiUrl ?? '-',
                    },
                    {
                      id: 'score',
                      header: 'スコア',
                      cell: (item) =>
                        item.score !== undefined ? `${item.score} pts` : '-',
                    },
                  ]}
                />
              </SpaceBetween>
            ),
          },
          {
            label: '攻撃管理',
            id: 'attacks',
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">攻撃カタログ</Header>}>
                  <SpaceBetween size="m">
                    <Box variant="p">
                      攻撃カタログを生成します。既存のカタログがある場合は上書きされます。
                    </Box>
                    <Button
                      variant="primary"
                      loading={actionLoading}
                      onClick={() => handleAction(() => seedAttacks(eventId))}
                    >
                      攻撃カタログ生成
                    </Button>
                  </SpaceBetween>
                </Container>
                <Table
                  header={
                    <Header
                      counter={`(${logs.length})`}
                      actions={
                        <Button
                          iconName="refresh"
                          variant="icon"
                          onClick={fetchData}
                          ariaLabel="更新"
                        />
                      }
                    >
                      攻撃ログ
                    </Header>
                  }
                  items={logs}
                  empty={
                    <Box textAlign="center" padding="l">
                      <Box variant="p" color="text-body-secondary">
                        攻撃ログがありません
                      </Box>
                    </Box>
                  }
                  columnDefinitions={[
                    {
                      id: 'time',
                      header: '時間',
                      cell: (item) => formatTime(item.createdAt),
                      sortingField: 'createdAt',
                    },
                    {
                      id: 'attacker',
                      header: '攻撃者',
                      cell: (item) => item.attackerTeamId,
                    },
                    {
                      id: 'defender',
                      header: '防衛者',
                      cell: (item) => item.defenderTeamId,
                    },
                    {
                      id: 'attack',
                      header: '攻撃',
                      cell: (item) => item.attackSlug,
                    },
                    {
                      id: 'success',
                      header: '結果',
                      cell: (item) => (
                        <StatusIndicator
                          type={item.success ? 'success' : 'error'}
                        >
                          {item.success ? '成功' : '失敗'}
                        </StatusIndicator>
                      ),
                    },
                    {
                      id: 'damage',
                      header: 'ダメージ',
                      cell: (item) => item.damage,
                    },
                  ]}
                />
              </SpaceBetween>
            ),
          },
          {
            label: '監査制御',
            id: 'audit',
            content: (
              <SpaceBetween size="l">
                <Container
                  header={<Header variant="h2">監査コントロール</Header>}
                >
                  <SpaceBetween size="m">
                    <Box variant="p">
                      ヘルスチェック監査プロセスを制御します。開始すると、全チームのウェブサイト/APIの定期的な健全性チェックが実行されます。
                    </Box>
                    <ColumnLayout columns={2} variant="text-grid">
                      <div>
                        <Box variant="awsui-key-label">監査ステータス</Box>
                        <StatusIndicator
                          type={auditorRunning ? 'success' : 'stopped'}
                        >
                          {auditorRunning ? '稼働中' : '停止'}
                        </StatusIndicator>
                      </div>
                    </ColumnLayout>
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button
                        variant="primary"
                        onClick={handleStartAuditor}
                        loading={actionLoading}
                        disabled={auditorRunning}
                      >
                        監査開始
                      </Button>
                      <Button
                        variant="normal"
                        onClick={handleStopAuditor}
                        loading={actionLoading}
                        disabled={!auditorRunning}
                      >
                        監査停止
                      </Button>
                    </SpaceBetween>
                  </SpaceBetween>
                </Container>
              </SpaceBetween>
            ),
          },
          {
            label: '妨害注入',
            id: 'fault-injection',
            content: (
              <SpaceBetween size="l">
                <Container
                  header={
                    <Header variant="h2">妨害注入（Fault Injection）</Header>
                  }
                >
                  <SpaceBetween size="m">
                    <Box variant="p">
                      管理者として指定チームに対して直接攻撃を実行します。
                    </Box>
                    <ColumnLayout columns={2}>
                      <FormField label="対象チーム">
                        <Select
                          selectedOption={fiTeamId}
                          onChange={({ detail }) =>
                            setFiTeamId(detail.selectedOption)
                          }
                          options={teams.map((t) => ({
                            value: t.teamId,
                            label: `${t.teamName} (${t.teamId})`,
                          }))}
                          placeholder="チームを選択"
                        />
                      </FormField>
                      <FormField label="攻撃">
                        <Select
                          selectedOption={fiAttackSlug}
                          onChange={({ detail }) =>
                            setFiAttackSlug(detail.selectedOption)
                          }
                          options={attacks.map((a) => ({
                            value: a.slug,
                            label: `${a.name} (${a.slug})`,
                          }))}
                          placeholder="攻撃を選択"
                        />
                      </FormField>
                    </ColumnLayout>
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button
                        variant="primary"
                        onClick={handleFaultInjection}
                        loading={fiLoading}
                        disabled={
                          !fiTeamId?.value || !fiAttackSlug?.value || fiLoading
                        }
                      >
                        妨害実行
                      </Button>
                      {fiResult && (
                        <StatusIndicator
                          type={fiResult.success ? 'success' : 'error'}
                        >
                          {fiResult.message}
                        </StatusIndicator>
                      )}
                    </SpaceBetween>
                  </SpaceBetween>
                </Container>
              </SpaceBetween>
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}
