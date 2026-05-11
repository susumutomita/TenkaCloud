/**
 * HTTP status code 名前付き定数 (= magic number 禁止のため `http-status-codes` library 経由)。
 *
 * 直接数値リテラル (`c.json(body, 500)` 等) は **禁止**。`StatusCodes.INTERNAL_SERVER_ERROR`
 * のような enum 経由で書く。意図 (200 vs 202、400 vs 409 等) を name で明示し、grep / lint で
 * 意味検索を可能にする。
 *
 * ## 推奨 (新規 / 既存リファクタとも)
 *
 * ```ts
 * import { StatusCodes } from "http-status-codes";
 * return c.json({ ok: true }, StatusCodes.OK);
 * ```
 *
 * ## 過渡的に残す legacy alias (= 既存 5 ファイルが使用中、徐々に StatusCodes.* に migrate 予定)
 *
 * `HTTP_*` は新規コードでは **使わない**。既存箇所だけ後方互換のため残してある。
 * 値は `StatusCodes.*` から派生するので、library 更新で自動追従する。
 */
import { StatusCodes } from "http-status-codes";

export { StatusCodes };

/** @deprecated 新規コードでは `StatusCodes.OK` を使う */
export const HTTP_OK = StatusCodes.OK;
/** @deprecated 新規コードでは `StatusCodes.CREATED` を使う */
export const HTTP_CREATED = StatusCodes.CREATED;
/** @deprecated 新規コードでは `StatusCodes.ACCEPTED` を使う */
export const HTTP_ACCEPTED = StatusCodes.ACCEPTED;
/** @deprecated 新規コードでは `StatusCodes.BAD_REQUEST` を使う */
export const HTTP_BAD_REQUEST = StatusCodes.BAD_REQUEST;
/** @deprecated 新規コードでは `StatusCodes.UNAUTHORIZED` を使う */
export const HTTP_UNAUTHORIZED = StatusCodes.UNAUTHORIZED;
/** @deprecated 新規コードでは `StatusCodes.NOT_FOUND` を使う */
export const HTTP_NOT_FOUND = StatusCodes.NOT_FOUND;
/** @deprecated 新規コードでは `StatusCodes.CONFLICT` を使う */
export const HTTP_CONFLICT = StatusCodes.CONFLICT;
/** @deprecated 新規コードでは `StatusCodes.INTERNAL_SERVER_ERROR` を使う */
export const HTTP_INTERNAL_ERROR = StatusCodes.INTERNAL_SERVER_ERROR;
