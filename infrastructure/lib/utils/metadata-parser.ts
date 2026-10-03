/**
 * 問題の `metadata.json` の **pure parser** 群 (SRP / Issue #2106)。
 *
 * `phases[]` / `disruptions[]` の純 parser は公開 SDK `@tenkacloud/problem-sdk` に
 * 単一の source of truth として集約済み。本 module は同名・同 signature で re-export
 * するので、 既存 importer (discover-problems-catalog / scoring Lambda 等) は従来通り
 * `metadata-parser.js` から import し続けられる。 公開面 (型 / 関数) は
 * `discover-problems-catalog.ts` からも re-export される。
 */

export {
  type DisruptionAction,
  type DisruptionActionKind,
  type DisruptionEffect,
  type DisruptionTrigger,
  type ProblemDisruptionEntry,
  parseDisruptionAction,
  parseDisruptionEffect,
  parseDisruptionsCatalogEnv,
  parseDisruptionTriggers,
} from "@tenkacloud/problem-sdk/internal";
