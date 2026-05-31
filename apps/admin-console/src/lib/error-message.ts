/**
 * unknown な throw 値を文字列に正規化する純関数。
 *
 * `Error` instance は `message` を、 それ以外 (string / 非 Error object) は `String()` で
 * 文字列化して返す。 各 page の `catch (err) { setError(err instanceof Error ? err.message :
 * String(err)) }` コピペを 1 箇所へ集約する (#1418 DRY / 単一責務、 sibling SPA の
 * lib/error-message.ts と同一実装)。
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
