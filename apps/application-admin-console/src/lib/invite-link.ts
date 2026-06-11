/**
 * 競技者招待リンク (#1772)。
 *
 * participant-portal の /login に teamLoginKey を URL fragment (`#invite=...`) で
 * 乗せたリンクを組み立てる。 fragment はブラウザがサーバーへ送信しない (= アクセスログ /
 * Referer に残らない) ので、 login key を経路上に晒さずワンクリック参加を実現できる。
 * portal 側 (participant-portal の readInviteKeyFromHash) と encode/decode が対になる。
 */
export function buildInviteLink(participantPortalUrl: string, teamLoginKey: string): string {
  const base = participantPortalUrl.replace(/\/+$/, "");
  return `${base}/login#invite=${encodeURIComponent(teamLoginKey)}`;
}
