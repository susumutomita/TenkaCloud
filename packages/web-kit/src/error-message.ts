/**
 * unknown な throw 値を user 向けの文字列に正規化する純関数 (3 SPA 共有、 #1418 DRY)。
 *
 * `Error` instance はその `message` を、 それ以外 (string / 非 Error object) は `String()` で
 * 文字列化して返す。 各 SPA の `catch (err) { setError(err instanceof Error ? err.message :
 * String(err)) }` コピペ (= 旧 admin-console / application-admin-console / participant-portal の
 * `src/lib/error-message.ts` に byte-identical で 3 重複) を 1 箇所へ集約する。
 *
 * domain 固有の整形 (例: EventList の 409 文脈付き message、 portal の friendly-error) は、 その
 * fallback として本関数を呼ぶ (= raw message 抽出の単一責務)。
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
