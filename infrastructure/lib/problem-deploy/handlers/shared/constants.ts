import type { DeploymentStatus } from "../deploy-handler/types.js";

/** problemId は metadata.json と整合する RFC 1035-ish の slug。両端は英数字、内側のみ - 許容。 */
export const PROBLEM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** ULID (Crockford Base32, 26 文字)。 */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Deployment が「削除中 or 削除済」と見なされる状態。
 * - lookup: GSI2 sparse 化が崩れた行を弾く
 * - update: 編集不可な行を skip
 */
export const DELETED_LIKE_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "DELETING",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);
