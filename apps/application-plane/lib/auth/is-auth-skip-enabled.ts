/**
 * AUTH_SKIP モードの共有判定ユーティリティ
 *
 * AUTH_SKIP=1 が設定されており、かつ本番環境でない場合にのみ true を返す。
 * 本番環境では AUTH_SKIP=1 が設定されていても常に false を返す。
 *
 * NOTE: モジュールレベルの throw は next build (NODE_ENV=production) 時に
 * .env.local の AUTH_SKIP=1 でビルドを壊すため、関数内で安全にガードする。
 */

/**
 * AUTH_SKIP モードが有効かどうかを判定する
 *
 * - AUTH_SKIP=1 かつ NODE_ENV !== 'production' の場合のみ true
 * - 本番環境では常に false（AUTH_SKIP=1 でも無視される）
 */
export function isAuthSkipEnabled(): boolean {
  return process.env.AUTH_SKIP === '1' && process.env.NODE_ENV !== 'production';
}
