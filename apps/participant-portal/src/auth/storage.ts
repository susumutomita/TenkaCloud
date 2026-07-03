import { z } from "zod";

/**
 * Participant session の `localStorage` 永続化層。
 *
 * Cognito ではなく per-team ログインキーで認証する。session の生存期間 (TTL) は
 * `expiresAt` で持っているので、保存は `localStorage` で十分かつ tab/reload を
 * またいで保たれる。`sessionStorage` だと tab を閉じる / 別 tab を開くたびに再
 * ログインが必要になり、競技中の UX を著しく損なう (Issue #495 報告)。
 *
 * `localStorage` は private window やブラウザ設定で利用不可なケースがある。その場合は
 * setter / getter とも throw せず無効化扱いにする (graceful degradation)。
 */

export const STORAGE_KEY = "TenkaCloud.participant.session";

export const ParticipantSessionSchema = z.object({
  sessionToken: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  eventId: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  /** unix ms。期限切れのセッションは自動 logout する。 */
  expiresAt: z.number().int().positive(),
  /**
   * 競技者が `PATCH /portal/me` で表示用チーム名を設定済みかのフラグ。
   * 未設定なら App.tsx で `/setup` へリダイレクトされる。
   * 後方互換のため optional (古い session 復元時は false 扱いになる)。
   */
  teamNameSetByCompetitor: z.boolean().optional().default(false),
});

export type ParticipantSession = z.infer<typeof ParticipantSessionSchema>;

export function loadSession(
  storage: Pick<Storage, "getItem"> = localStorage,
): ParticipantSession | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch {
    console.warn("[portal] session JSON parse failed, clearing");
    clearSession();
    return null;
  }

  const result = ParticipantSessionSchema.safeParse(parsedUnknown);
  if (!result.success) {
    // 旧 shape の session が残っている / 手動編集された場合はここで落ちる。
    // 原因特定のため issues 一覧をログに出す (= プレーンテキスト、PII なし)。
    console.warn("[portal] session schema violation, clearing", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
    });
    clearSession();
    return null;
  }
  if (result.data.expiresAt <= Date.now()) {
    clearSession();
    return null;
  }
  return result.data;
}

export function saveSession(session: ParticipantSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 利用不可。次回 load で null になり再ログインが要求される
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
