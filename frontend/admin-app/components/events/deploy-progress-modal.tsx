'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getDeploymentProgress } from '@/lib/api/events';

interface DeployProgressModalProps {
  jobId: string;
  eventName: string;
  onClose: () => void;
  onComplete: () => void;
}

interface DeploymentTask {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message?: string;
}

export function DeployProgressModal({
  jobId,
  eventName,
  onClose,
  onComplete,
}: DeployProgressModalProps) {
  const [status, setStatus] = useState<
    'pending' | 'running' | 'completed' | 'failed'
  >('pending');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('デプロイを開始しています...');
  const [tasks, setTasks] = useState<DeploymentTask[]>([
    { id: '1', name: 'CloudFormation テンプレートの検証', status: 'pending' },
    { id: '2', name: '競技者アカウントの準備', status: 'pending' },
    { id: '3', name: 'VPC / ネットワークの構築', status: 'pending' },
    { id: '4', name: 'IAM ロールの作成', status: 'pending' },
    { id: '5', name: '問題環境のデプロイ', status: 'pending' },
    { id: '6', name: '採点関数のデプロイ', status: 'pending' },
    { id: '7', name: 'ヘルスチェック', status: 'pending' },
    { id: '8', name: 'メタデータの登録', status: 'pending' },
  ]);

  const pollProgress = useCallback(async () => {
    try {
      const result = await getDeploymentProgress(jobId);
      setStatus(result.status);
      setProgress(result.progress);
      setMessage(result.message);

      // タスクの状態を更新
      setTasks((prev) =>
        prev.map((task, index) => {
          if (index < result.completedTasks) {
            return { ...task, status: 'completed' };
          } else if (index === result.completedTasks) {
            return {
              ...task,
              status: result.status === 'running' ? 'running' : 'pending',
            };
          }
          return task;
        })
      );

      if (result.status === 'completed') {
        onComplete();
      }

      return result.status;
    } catch (error) {
      console.error('Failed to get deployment progress:', error);
      setStatus('failed');
      setMessage('デプロイの進捗取得に失敗しました');
      return 'failed';
    }
  }, [jobId, onComplete]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const currentStatus = await pollProgress();
      if (currentStatus === 'completed' || currentStatus === 'failed') {
        clearInterval(interval);
      }
    }, 2000);

    // 初回実行
    pollProgress();

    return () => clearInterval(interval);
  }, [pollProgress]);

  const statusColors = {
    pending: 'bg-gray-200',
    running: 'bg-blue-500',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
  };

  const getTaskIcon = (taskStatus: DeploymentTask['status']) => {
    switch (taskStatus) {
      case 'completed':
        return (
          <svg
            className="h-5 w-5 text-green-500"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
        );
      case 'running':
        return (
          <svg
            className="h-5 w-5 text-blue-500 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
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
        );
      case 'failed':
        return (
          <svg
            className="h-5 w-5 text-red-500"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
        );
      default:
        return (
          <div className="h-5 w-5 rounded-full border-2 border-gray-300" />
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-lg mx-4">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>デプロイ進捗</CardTitle>
            <Badge className={`${statusColors[status]} text-white`}>
              {status === 'pending' && '準備中'}
              {status === 'running' && '実行中'}
              {status === 'completed' && '完了'}
              {status === 'failed' && '失敗'}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{eventName}</p>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* プログレスバー */}
          <div>
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-muted-foreground">{message}</span>
              <span className="font-medium">{progress}%</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  status === 'failed' ? 'bg-red-500' : 'bg-blue-500'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* タスク一覧 */}
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {tasks.map((task) => (
              <div
                key={task.id}
                className={`flex items-center gap-3 p-2 rounded ${
                  task.status === 'running' ? 'bg-blue-50' : ''
                }`}
              >
                {getTaskIcon(task.status)}
                <span
                  className={`text-sm ${
                    task.status === 'completed'
                      ? 'text-gray-500'
                      : task.status === 'running'
                        ? 'text-blue-700 font-medium'
                        : 'text-gray-700'
                  }`}
                >
                  {task.name}
                </span>
              </div>
            ))}
          </div>

          {/* アクションボタン */}
          <div className="flex justify-end gap-2">
            {status === 'running' || status === 'pending' ? (
              <Button variant="outline" onClick={onClose}>
                バックグラウンドで実行
              </Button>
            ) : (
              <Button onClick={onClose}>閉じる</Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
