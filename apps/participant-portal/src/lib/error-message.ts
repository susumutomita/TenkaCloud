/**
 * unknown な throw 値を文字列に正規化する純関数。
 *
 * `Error` instance は `message` を、 それ以外 (string / 非 Error object) は `String()` で
 * 文字列化して返す。 portal 各所の `catch (err) { ... err instanceof Error ? err.message :
 * String(err) ... }` を 10 箇所コピペしていたのを 1 箇所へ集約する (#1418 DRY / 単一責務)。
 *
 * 競技者向けの文脈付き整形 (= ログイン期限切れ等) は friendly-error.ts の責務で、 本関数は
 * その素の fallback (raw message) を担う。
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
