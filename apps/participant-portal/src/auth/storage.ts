/**
 * Participant session の sessionStorage 永続化層。
 *
 * Cognito ではなく per-team ログインキーで認証するので、ローカルでは
 * sessionStorage に session token + チーム情報を保存し、ブラウザを閉じたら消える形にする。
 * (localStorage を使わない理由: 競技中は同一 tab で完結する想定 + ブラウザ共用時の安全)
 */

const STORAGE_KEY = "TenkaCloud.participant.session";

export interface ParticipantSession {
  /** backend が返す不透明な session token (本物の backend ができるまでは mock 値)。 */
  readonly sessionToken: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly eventId: string;
  readonly issuedAt: number;
  /** unix ms。期限切れのセッションは自動 logout する。 */
  readonly expiresAt: number;
}

export function loadSession(): ParticipantSession | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ParticipantSession;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function saveSession(session: ParticipantSession): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
