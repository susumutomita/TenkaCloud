import { z } from "zod";

/**
 * Participant session の sessionStorage 永続化層。
 *
 * Cognito ではなく per-team ログインキーで認証するので、ローカルでは
 * sessionStorage に session token + チーム情報を保存し、ブラウザを閉じたら消える形にする。
 * (localStorage を使わない理由: 競技中は同一 tab で完結する想定 + ブラウザ共用時の安全)
 *
 * sessionStorage は private window やブラウザ設定で利用不可なケースがある。その場合は
 * setter / getter とも throw せず無効化扱いにする (graceful degradation)。
 */

const STORAGE_KEY = "TenkaCloud.participant.session";

export const ParticipantSessionSchema = z.object({
  sessionToken: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  eventId: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  /** unix ms。期限切れのセッションは自動 logout する。 */
  expiresAt: z.number().int().positive(),
});

export type ParticipantSession = z.infer<typeof ParticipantSessionSchema>;

export function loadSession(): ParticipantSession | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch {
    clearSession();
    return null;
  }

  const result = ParticipantSessionSchema.safeParse(parsedUnknown);
  if (!result.success || result.data.expiresAt <= Date.now()) {
    clearSession();
    return null;
  }
  return result.data;
}

export function saveSession(session: ParticipantSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 利用不可。次回 load で null になり再ログインが要求される
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
