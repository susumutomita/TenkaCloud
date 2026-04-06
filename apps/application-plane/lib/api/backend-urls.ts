/**
 * Backend Service URL Configuration
 *
 * 全バックエンドサービスの URL を環境変数から一元管理する。
 * API ルートやサーバーコンポーネントから直接 URL をハードコードする代わりに
 * このモジュールのヘルパー関数を使用する。
 */

/**
 * Problem Service (events, problems, scoring) の URL を取得する
 *
 * 環境変数: API_URL, NEXT_PUBLIC_API_URL
 * デフォルト: http://localhost:3100/api
 */
export function getProblemServiceUrl(): string {
  return (
    process.env.API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:3100/api'
  );
}

/**
 * GameDay Service の URL を取得する
 *
 * 環境変数: GAMEDAY_API_URL, NEXT_PUBLIC_GAMEDAY_API_URL
 * デフォルト: http://localhost:3020/api/gameday
 */
export function getGamedayApiUrl(): string {
  return (
    process.env.GAMEDAY_API_URL ||
    process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
    'http://localhost:3020/api/gameday'
  );
}

/**
 * Tenant Management Service の URL を取得する
 *
 * 環境変数: TENANT_SERVICE_URL
 * デフォルト: http://localhost:3200/api/tenant
 */
export function getTenantServiceUrl(): string {
  return process.env.TENANT_SERVICE_URL || 'http://localhost:3200/api/tenant';
}

/**
 * Leaderboard Service の URL を取得する
 *
 * 環境変数: LEADERBOARD_API_URL, NEXT_PUBLIC_LEADERBOARD_API_URL
 * デフォルト: http://localhost:3012
 */
export function getLeaderboardApiUrl(): string {
  return (
    process.env.LEADERBOARD_API_URL ||
    process.env.NEXT_PUBLIC_LEADERBOARD_API_URL ||
    'http://localhost:3012'
  );
}

/**
 * 全バックエンドサービスの URL マップを取得する
 *
 * ヘルスチェックやデバッグで使用
 */
export function getAllServiceUrls(): Record<string, string> {
  return {
    'problem-service': getProblemServiceUrl(),
    'gameday-service': getGamedayApiUrl(),
    'leaderboard-service': getLeaderboardApiUrl(),
    'tenant-management': getTenantServiceUrl(),
  };
}
