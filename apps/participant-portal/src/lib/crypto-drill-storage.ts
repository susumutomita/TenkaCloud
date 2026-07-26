/**
 * 学習ドリルの進捗を localStorage に置く。
 *
 * `notifications-storage.ts` と同じ判断で、進捗は **競技者のブラウザに閉じ込める**。
 * 学習の進み具合はスコアでも提出物でもないので、サーバ側に API と表を増やす理由がない。
 * 直列化と検証は `@tenkacloud/crypto-drill` の `serializeProgress` / `parseProgress` が持ち、
 * ここは保存先だけを担う。
 *
 * private window / quota 超過で読み書きが失敗しても throw しない。進捗が保存できないことは
 * 学習を止める理由にならないため、その場合はセッション内だけ進捗が残る挙動へ落とす。
 */

import {
  type DrillProgress,
  emptyProgress,
  parseProgress,
  serializeProgress,
} from "@tenkacloud/crypto-drill";

const STORAGE_KEY_PREFIX = "TenkaCloud.participant.cryptoDrillProgress";

/** ドリル単位で key を分ける (SHA-256 の進捗が HMAC の進捗を上書きしないように)。 */
export function drillStorageKey(drillId: string): string {
  return `${STORAGE_KEY_PREFIX}:${drillId}`;
}

/**
 * 保存済みの進捗を読む。未保存・壊れた値・別ドリルの値はすべて空の進捗を返す
 * (静かに部分復元して達成状況を捏造しない)。
 */
export function loadDrillProgress(
  drillId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): DrillProgress {
  try {
    const raw = storage.getItem(drillStorageKey(drillId));
    if (raw === null) return emptyProgress(drillId);
    return parseProgress(raw, drillId) ?? emptyProgress(drillId);
  } catch {
    return emptyProgress(drillId);
  }
}

/** 進捗を保存する。失敗しても throw しない。 */
export function saveDrillProgress(
  progress: DrillProgress,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(drillStorageKey(progress.drillId), serializeProgress(progress));
  } catch {
    // private window / quota 超過。 セッション内の進捗だけで続行する。
  }
}
