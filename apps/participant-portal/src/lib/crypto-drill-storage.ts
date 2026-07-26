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

/** 読み出し結果。`persisted` が false なら storage が使えていない。 */
export interface LoadedDrillProgress {
  readonly progress: DrillProgress;
  /**
   * storage を読めたか。false は「private window 等で保存が効かない」ことを意味し、
   * 画面はこれを見て学習者へ警告を出す。壊れた値・別ドリルの値・未保存は storage 自体は
   * 読めているので true (= 保存は今後も効く)。
   */
  readonly persisted: boolean;
}

/**
 * 保存済みの進捗を読む。未保存・壊れた値・別ドリルの値はすべて空の進捗を返す
 * (静かに部分復元して達成状況を捏造しない)。
 *
 * storage が使えないときも throw せず空の進捗で続行するが、その事実は `persisted: false`
 * として返す。黙って毎回リセットすると、学習者は 15 節進めた後の reload で初めて
 * 進捗が消えていたことに気づく。
 */
export function loadDrillProgress(
  drillId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): LoadedDrillProgress {
  try {
    const raw = storage.getItem(drillStorageKey(drillId));
    if (raw === null) return { progress: emptyProgress(drillId), persisted: true };
    return { progress: parseProgress(raw, drillId) ?? emptyProgress(drillId), persisted: true };
  } catch {
    return { progress: emptyProgress(drillId), persisted: false };
  }
}

/**
 * 進捗を保存する。失敗しても throw しないが、保存できたかを返す。
 *
 * 失敗しても学習は続けられるべきなので例外にはしない (private window でドリルが
 * 使えなくなる方が学習者にとって損失が大きい)。代わりに false を返し、呼び出し側が
 * 「この端末では進捗を保存できない」と表示する。
 */
export function saveDrillProgress(
  progress: DrillProgress,
  storage: Pick<Storage, "setItem"> = localStorage,
): boolean {
  try {
    storage.setItem(drillStorageKey(progress.drillId), serializeProgress(progress));
    return true;
  } catch {
    return false;
  }
}
