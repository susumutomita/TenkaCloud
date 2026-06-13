/**
 * 競技者招待リンク (#1772) の受け側。
 *
 * application-admin-console の buildInviteLink が生成する
 * `/login#invite=<encodeURIComponent(teamLoginKey)>` の fragment から login key を読む。
 * fragment はサーバーへ送信されない (= アクセスログ / Referer に残らない) ことが
 * このリンク形式を選んだ理由。読み取り後は履歴に key を残さないよう
 * clearInviteHash() で URL から落とす。
 */

const INVITE_PREFIX = "#invite=";

/** location.hash から招待 key を取り出す。招待リンク以外 / 壊れた encode は null。 */
export function readInviteKeyFromHash(hash: string): string | null {
  if (!hash.startsWith(INVITE_PREFIX)) return null;
  const raw = hash.slice(INVITE_PREFIX.length);
  if (raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // 壊れた percent-encoding (= 招待リンクとして不成立)。 prefill しないだけで、
    // ユーザーは通常どおり手入力でログインできる。
    return null;
  }
}

/** 招待 fragment を URL / 履歴から除去する (key をアドレスバーに残さない)。 */
export function clearInviteHash(): void {
  if (!window.location.hash.startsWith(INVITE_PREFIX)) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
