/**
 * Admin Problem Deploy Page
 *
 * HybridNext Design System - Terminal Command Center style
 * 問題デプロイ画面 - AWS へのデプロイ実行
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge, Input, ProblemTypeBadge, Select } from '@/components/ui';
import {
  deleteDeployment,
  deployProblem,
  getAWSRegions,
  getDeploymentStatus,
  getProblem,
} from '@/lib/api/admin-problems';
import type {
  AdminProblem,
  AWSRegion,
  DeploymentStatus,
} from '@/lib/api/admin-types';

type DeployState = 'idle' | 'deploying' | 'success' | 'error';

export default function AdminProblemDeployPage() {
  const params = useParams();
  const problemId = params.id as string;

  const [problem, setProblem] = useState<AdminProblem | null>(null);
  const [regions, setRegions] = useState<AWSRegion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Deploy form state
  const [selectedRegion, setSelectedRegion] = useState('');
  const [stackName, setStackName] = useState('');
  const [dryRun, setDryRun] = useState(false);

  // Deploy state
  const [deployState, setDeployState] = useState<DeployState>('idle');
  const [deployMessage, setDeployMessage] = useState<string | null>(null);
  const [deployedStackName, setDeployedStackName] = useState<string | null>(
    null
  );
  const [deploymentStatus, setDeploymentStatus] =
    useState<DeploymentStatus | null>(null);

  const regionSelectId = useId();
  const stackNameInputId = useId();
  const dryRunCheckboxId = useId();

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const [problemData, regionsData] = await Promise.all([
          getProblem(problemId),
          getAWSRegions(),
        ]);

        setProblem(problemData);
        setRegions(regionsData.regions);

        // デフォルトリージョンを設定
        if (regionsData.regions.length > 0) {
          const defaultRegion = regionsData.regions.find(
            (r) => r.code === 'ap-northeast-1'
          );
          setSelectedRegion(defaultRegion?.code || regionsData.regions[0].code);
        }
      } catch (err) {
        console.error('Failed to fetch data:', err);
        setError('データの取得に失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [problemId]);

  const handleDeploy = async () => {
    if (!selectedRegion) {
      alert('リージョンを選択してください');
      return;
    }

    try {
      setDeployState('deploying');
      setDeployMessage('デプロイを開始しています...');
      setDeploymentStatus(null);

      const result = await deployProblem(problemId, {
        region: selectedRegion,
        stackName: stackName || undefined,
        dryRun,
      });

      setDeployedStackName(result.stackName);
      setDeployMessage(result.message);
      setDeployState('success');

      // ステータスを取得
      if (!dryRun) {
        const status = await getDeploymentStatus(
          problemId,
          result.stackName,
          selectedRegion
        );
        setDeploymentStatus(status);
      }
    } catch (err) {
      console.error('Deploy failed:', err);
      setDeployState('error');
      setDeployMessage(
        err instanceof Error ? err.message : 'デプロイに失敗しました'
      );
    }
  };

  const handleRefreshStatus = async () => {
    if (!deployedStackName || !selectedRegion) return;

    try {
      const status = await getDeploymentStatus(
        problemId,
        deployedStackName,
        selectedRegion
      );
      setDeploymentStatus(status);
    } catch (err) {
      console.error('Failed to refresh status:', err);
    }
  };

  const handleDeleteStack = async () => {
    if (!deployedStackName || !selectedRegion) return;
    if (!confirm('スタックを削除しますか？この操作は取り消せません。')) {
      return;
    }

    try {
      setDeployMessage('スタックを削除しています...');
      await deleteDeployment(problemId, deployedStackName, selectedRegion);
      setDeployMessage('スタックが削除されました');
      setDeploymentStatus(null);
      setDeployedStackName(null);
      setDeployState('idle');
    } catch (err) {
      console.error('Failed to delete stack:', err);
      alert('スタックの削除に失敗しました');
    }
  };

  const getStatusBadgeVariant = (
    status: string
  ): 'default' | 'success' | 'warning' | 'danger' => {
    if (status.includes('COMPLETE') && !status.includes('ROLLBACK')) {
      return 'success';
    }
    if (status.includes('IN_PROGRESS')) {
      return 'warning';
    }
    if (status.includes('FAILED') || status.includes('ROLLBACK')) {
      return 'danger';
    }
    return 'default';
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-20" />
          <Skeleton className="h-8 w-1/3" />
        </div>
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-1/4" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !problem) {
    return (
      <div className="space-y-6">
        <Card className="border-hn-error">
          <CardContent className="p-6 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              {error || '問題が見つかりません'}
            </h2>
            <Button asChild variant="secondary" className="mt-4">
              <Link href="/admin/problems">問題一覧に戻る</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!problem.deployment.providers.includes('aws')) {
    return (
      <div className="space-y-6">
        <Card className="border-hn-warning">
          <CardContent className="p-6 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              この問題は AWS デプロイに対応していません
            </h2>
            <p className="text-text-muted mb-4">
              対応プロバイダー:{' '}
              {problem.deployment.providers
                .map((p) => p.toUpperCase())
                .join(', ')}
            </p>
            <Button asChild variant="secondary">
              <Link href={`/admin/problems/${problem.id}`}>問題詳細に戻る</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/problems/${problem.id}`}>
              <svg
                className="w-5 h-5 mr-1"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              戻る
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
              <span className="text-hn-accent font-mono">&gt;_</span>
              AWS デプロイ
            </h1>
            <p className="text-sm text-text-muted">{problem.title}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Deploy Form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <svg
                className="w-5 h-5 text-hn-accent"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              デプロイ設定
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label
                htmlFor={regionSelectId}
                className="block text-sm font-medium text-text-muted mb-1"
              >
                リージョン *
              </label>
              <Select
                id={regionSelectId}
                value={selectedRegion}
                onChange={(e) => setSelectedRegion(e.target.value)}
                options={regions.map((r) => ({
                  value: r.code,
                  label: `${r.name} (${r.code})`,
                }))}
                disabled={deployState === 'deploying'}
              />
            </div>

            <div>
              <label
                htmlFor={stackNameInputId}
                className="block text-sm font-medium text-text-muted mb-1"
              >
                スタック名（オプション）
              </label>
              <Input
                id={stackNameInputId}
                type="text"
                placeholder="自動生成されます"
                value={stackName}
                onChange={(e) => setStackName(e.target.value)}
                disabled={deployState === 'deploying'}
              />
              <p className="text-xs text-text-muted mt-1">
                英数字とハイフンのみ。省略時は自動生成されます。
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                id={dryRunCheckboxId}
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                disabled={deployState === 'deploying'}
                className="rounded border-border text-hn-accent focus:ring-hn-accent"
              />
              <label
                htmlFor={dryRunCheckboxId}
                className="text-sm text-text-secondary"
              >
                テンプレート検証のみ（実際のデプロイは行わない）
              </label>
            </div>

            <Button
              onClick={handleDeploy}
              disabled={deployState === 'deploying' || !selectedRegion}
              className="w-full"
            >
              {deployState === 'deploying' ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-3 h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  デプロイ中...
                </>
              ) : dryRun ? (
                'テンプレートを検証'
              ) : (
                'デプロイを開始'
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Deploy Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <svg
                className="w-5 h-5 text-hn-accent"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              ステータス
            </CardTitle>
          </CardHeader>
          <CardContent>
            {deployState === 'idle' && (
              <div className="text-center py-8 text-text-muted">
                <div className="text-4xl mb-4">🚀</div>
                <p>デプロイを開始してください</p>
              </div>
            )}

            {deployState === 'deploying' && (
              <div className="text-center py-8">
                <div className="text-4xl mb-4 animate-bounce">🔄</div>
                <p className="text-text-secondary">{deployMessage}</p>
              </div>
            )}

            {deployState === 'success' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-hn-success">
                  <svg
                    className="w-6 h-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <span className="font-medium">{deployMessage}</span>
                </div>

                {deployedStackName && (
                  <div className="p-3 bg-surface-2 rounded-[var(--radius)]">
                    <p className="text-sm text-text-muted">スタック名</p>
                    <p className="font-mono text-text-primary break-all">
                      {deployedStackName}
                    </p>
                  </div>
                )}

                {deploymentStatus && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-muted">
                        ステータス
                      </span>
                      <Badge
                        variant={getStatusBadgeVariant(deploymentStatus.status)}
                      >
                        {deploymentStatus.status}
                      </Badge>
                    </div>

                    {deploymentStatus.statusReason && (
                      <div>
                        <p className="text-sm text-text-muted mb-1">詳細</p>
                        <p className="text-sm text-text-secondary">
                          {deploymentStatus.statusReason}
                        </p>
                      </div>
                    )}

                    {deploymentStatus.outputs &&
                      Object.keys(deploymentStatus.outputs).length > 0 && (
                        <div>
                          <p className="text-sm text-text-muted mb-2">出力</p>
                          <div className="space-y-2">
                            {Object.entries(deploymentStatus.outputs).map(
                              ([key, value]) => (
                                <div
                                  key={key}
                                  className="p-2 bg-surface-2 rounded-[var(--radius)]"
                                >
                                  <p className="text-xs text-text-muted">
                                    {key}
                                  </p>
                                  <p className="text-sm font-mono text-text-primary break-all">
                                    {value}
                                  </p>
                                </div>
                              )
                            )}
                          </div>
                        </div>
                      )}

                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleRefreshStatus}
                      >
                        ステータス更新
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-hn-error hover:text-hn-error hover:bg-hn-error/10"
                        onClick={handleDeleteStack}
                      >
                        スタック削除
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {deployState === 'error' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-hn-error">
                  <svg
                    className="w-6 h-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                  <span className="font-medium">デプロイに失敗しました</span>
                </div>
                <p className="text-sm text-text-secondary">{deployMessage}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDeployState('idle');
                    setDeployMessage(null);
                  }}
                >
                  再試行
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Problem Info */}
      <Card>
        <CardHeader>
          <CardTitle>問題情報</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-text-muted">タイプ</p>
              <ProblemTypeBadge type={problem.type} />
            </div>
            <div>
              <p className="text-text-muted">難易度</p>
              <p className="text-text-primary">{problem.difficulty}</p>
            </div>
            <div>
              <p className="text-text-muted">カテゴリ</p>
              <p className="text-text-primary">{problem.category}</p>
            </div>
            <div>
              <p className="text-text-muted">タイムアウト</p>
              <p className="text-text-primary font-mono">
                {problem.deployment.timeout || 60}分
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> aws cloudformation deploy
        --stack-name {deployedStackName || '...'} --region {selectedRegion}
      </div>
    </div>
  );
}
