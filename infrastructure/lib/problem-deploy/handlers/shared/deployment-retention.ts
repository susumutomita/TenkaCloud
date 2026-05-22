/**
 * Issue #1200: Deployments テーブルの retention 設計。
 *
 * 旧来:
 *   - `deploy-handler/deploy.ts` が create 時に `expiresAt = now + 8h` (= competition
 *     session TTL) を SET していた。
 *   - 8 時間後に DDB TTL が行を sweep するため、 翌日には audit 履歴が全部消える。
 *   - operator が deploy 失敗の事後解析や 「先週の event のレビュー」 をしようとしても
 *     行が無い、 という UX 問題があった。
 *
 * 新 (= 本 helper の役割):
 *   - **terminal 化** (= COMPLETE / FAILED / DELETED / DELETING / EXPIRED / AUTO_DELETED)
 *     した時点で `expiresAt = now + 7 days` に refresh する。
 *   - これにより 「terminal 化してから 7 日間は audit 履歴が残る」 を保証。
 *   - terminal でない (= PENDING / IN_PROGRESS) は短い session TTL のまま (= 競技中の
 *     行が放置されて長期肥大化するのを防ぐ)。
 *
 * DDB TTL feature でバックグラウンド sweep されるため、 Lambda / Cron は不要 (= cost-zero
 * 原則に整合)。 厳密 7 日 + α (= DDB の挙動上 数時間遅延あり、 規約上 OK)。
 *
 * 注意:
 *   - Step Functions 側で `Items.UpdateItem` を発行する terminal transition (= CFn 完了
 *     を polling して COMPLETE / DELETED を書く path) は本 helper を呼ばない CDK 領域。
 *     現状は create 時の `expiresAt = now + 7d` (= bulk-deploy.ts) が retention 役を
 *     兼ねており、 大半の deploy が 24h 以内に terminal 化することから 約 6-7 日 の
 *     post-terminal retention を実効で得ている。 厳密に 「terminal 化から 7 日」 に
 *     合わせたい場合は CDK の state machine 末端タスクで `expiresAt` を SET する step を
 *     入れる (= follow-up、 user 領域)。
 */
const DEPLOYMENT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * terminal status に遷移した行に SET すべき `expiresAt` (= DDB TTL attribute 値、 epoch
 * seconds) を返す。 呼び元の UpdateItemCommand の UpdateExpression に
 * `, expiresAt = :expiresAt` を追加し、 ExpressionAttributeValues で本値を渡す。
 */
export function deploymentTerminalExpiresAt(nowMs: number): number {
  return Math.floor((nowMs + DEPLOYMENT_TERMINAL_RETENTION_MS) / 1000);
}
