/**
 * LP デモ (dev-mock) の解答進捗を tab セッション内で持続させる store。
 *
 * MultiFlagSubmissionPanel の solved 状態はコンポーネントローカル state なので、
 * 問題一覧へ戻って開き直すと unmount で進捗が消え 「解いたのに未クリアに戻る」
 * ように見える (2026-07-21 デモ報告)。 backend の無い dev-mock では server truth を
 * refetch できないため、 sessionStorage に problemId → solved flagId 集合を保存して
 * 画面遷移・リロードをまたいで復元する。 localStorage にしないのは、 デモを別途
 * 開き直したときはまっさらな状態から始めたいため (tab セッション = 1 デモ体験)。
 *
 * private window / quota 超過などで storage が使えなくても throw しない
 * (graceful degradation — その場合は従来どおり遷移で進捗が消えるだけ)。
 */

const STORAGE_KEY = "TenkaCloud.participant.devMockSolvedFlags";

type SolvedMap = Readonly<Record<string, readonly string[]>>;

function loadAll(storage: Pick<Storage, "getItem">): SolvedMap {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, readonly string[]> = {};
    for (const [problemId, flagIds] of Object.entries(parsed)) {
      if (!Array.isArray(flagIds)) return {};
      result[problemId] = flagIds.filter((id): id is string => typeof id === "string");
    }
    return result;
  } catch {
    return {};
  }
}

/** デモで solved 済みの flagId 集合を返す。未保存 / storage 不可なら空集合。 */
export function loadMockSolvedFlagIds(
  problemId: string,
  storage: Pick<Storage, "getItem"> = sessionStorage,
): ReadonlySet<string> {
  return new Set(loadAll(storage)[problemId] ?? []);
}

/** デモで flag を solved にした事実を保存する。書き込み失敗は無視する。 */
export function saveMockSolvedFlagId(
  problemId: string,
  flagId: string,
  storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage,
): void {
  try {
    const all = loadAll(storage);
    const next = new Set(all[problemId] ?? []);
    next.add(flagId);
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...all, [problemId]: [...next] }));
  } catch {
    // ignore
  }
}
