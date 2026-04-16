/**
 * ErrorState Component
 *
 * ユーザーフレンドリーなエラー表示コンポーネント
 */

import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from './button';
import { Card } from './card';

export interface ErrorStateProps {
  /** エラータイトル */
  title?: string;
  /** エラーメッセージ */
  message: string;
  /** リトライアクション */
  onRetry?: () => void;
  /** リトライボタンのラベル */
  retryLabel?: string;
  /** エラータイプ（アイコン選択用） */
  type?: 'network' | 'general' | 'notFound';
}

/**
 * 技術的なエラーメッセージをユーザーフレンドリーなメッセージに変換
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.toLowerCase();

    if (message.includes('failed to fetch') || message.includes('network')) {
      return 'サーバーに接続できません。ネットワーク接続を確認してください。';
    }
    if (message.includes('404') || message.includes('not found')) {
      return 'データが見つかりませんでした。';
    }
    if (message.includes('401') || message.includes('unauthorized')) {
      return '認証が必要です。再ログインしてください。';
    }
    if (message.includes('403') || message.includes('forbidden')) {
      return 'アクセス権限がありません。';
    }
    if (message.includes('500') || message.includes('internal server')) {
      return 'サーバーエラーが発生しました。しばらくしてから再試行してください。';
    }
    if (message.includes('timeout')) {
      return 'リクエストがタイムアウトしました。再試行してください。';
    }
  }

  return 'データの読み込みに失敗しました。しばらくしてから再試行してください。';
}

/**
 * エラータイプを判定
 */
export function getErrorType(err: unknown): 'network' | 'notFound' | 'general' {
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (message.includes('failed to fetch') || message.includes('network')) {
      return 'network';
    }
    if (message.includes('404') || message.includes('not found')) {
      return 'notFound';
    }
  }
  return 'general';
}

const icons = {
  network: WifiOff,
  general: AlertTriangle,
  notFound: AlertTriangle,
};

export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = '再試行',
  type = 'general',
}: ErrorStateProps) {
  const Icon = icons[type];

  const defaultTitles = {
    network: '接続エラー',
    general: 'エラーが発生しました',
    notFound: '見つかりません',
  };

  return (
    <Card className="text-center py-12 px-6">
      <div className="flex justify-center mb-4">
        <div className="w-16 h-16 rounded-full bg-hn-error/10 flex items-center justify-center">
          <Icon className="w-8 h-8 text-hn-error" />
        </div>
      </div>

      <h2 className="text-xl font-semibold text-text-primary mb-2">
        {title || defaultTitles[type]}
      </h2>

      <p className="text-text-secondary mb-6 max-w-md mx-auto">{message}</p>

      {onRetry && (
        <Button onClick={onRetry} variant="outline" className="gap-2">
          <RefreshCw className="w-4 h-4" />
          {retryLabel}
        </Button>
      )}
    </Card>
  );
}
