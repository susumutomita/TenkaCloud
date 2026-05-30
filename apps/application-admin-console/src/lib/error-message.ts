/**
 * unknown な throw 値を user 向けの文字列に正規化する。
 *
 * `Error` instance はその `message` を、 それ以外 (string / 非 Error object など) は
 * `String()` で文字列化して返す。 handler の `catch (err) { setError(...) }` で
 * `err instanceof Error ? err.message : String(err)` を 20+ 箇所にコピペしていたのを
 * 1 箇所へ集約する (DRY / 単一責務)。 domain 固有の整形 (例: EventList の
 * `describeArchiveError` の 409 文脈付き message) は、 その fallback としてこれを呼ぶ。
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
