/**
 * 共有型 — DeploymentDetail ページの sub-component 間で受け渡す state shape を集約する。
 */

/** i18n の useT() 戻り値と同じ shape を持つ翻訳関数。 */
export type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * StackProgress 取得失敗時の state。`notYetCreated=true` のときは「準備中」graceful UI に
 * 集約され、 raw error は出さない (#687 / #656 と同 pattern)。
 */
export type StackProgressErrorState = {
  message: string;
  notYetCreated: boolean;
};
