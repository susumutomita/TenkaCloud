import type { Settings } from '@/types/settings';

/**
 * 設定を保存する
 * TODO: 実際の API エンドポイントに接続する
 */
export async function saveSettings(_settings: Settings): Promise<void> {
  // モック実装 - 500ms 待機して成功
  await new Promise((resolve) => setTimeout(resolve, 500));
}
