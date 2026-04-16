/**
 * AUTH_SKIP モードの共有判定ユーティリティ
 *
 * AUTH_SKIP=1 が設定されており、かつ本番環境でない場合にのみ true を返す。
 * 本番環境で AUTH_SKIP=1 が設定されている場合はエラーを投げる。
 */

/**
 * AUTH_SKIP モードが有効かどうかを判定する
 *
 * - AUTH_SKIP=1 かつ NODE_ENV !== 'production' の場合のみ true
 * - 本番環境で AUTH_SKIP=1 が設定されている場合はエラーを投げる
 */
export function isAuthSkipEnabled(): boolean {
  if (process.env.AUTH_SKIP === '1' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SKIP=1 is not allowed in production. Remove AUTH_SKIP or set NODE_ENV to a non-production value.',
    );
  }
  return process.env.AUTH_SKIP === '1' && process.env.NODE_ENV !== 'production';
}
