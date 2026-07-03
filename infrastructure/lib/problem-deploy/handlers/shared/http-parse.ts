import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import type { z } from "zod";

/**
 * Issue #2211 (RC-21 第2弾): リクエスト境界の parse を 1 箇所に集約する共有モジュール。
 *
 * 「JSON body / query / path param を取り出す → Zod schema で検証する → 失敗を標準 400 に
 * 整形する」という同形処理が participant / event / deploy の各 handler にコピーされていた
 * (participant-handler だけでも `validation_failed` ブロックが 3 回)。ここに寄せることで、
 * フロントが依存するエラー形状の修正が 1 箇所で済み、handler 間の無音ドリフトを防ぐ。
 *
 * エラー形状は #2196 のテストで固定された契約であり、byte 単位で不変:
 *  - JSON parse 失敗            → `{ error: "invalid_body" }`                       (400)
 *  - schema validate 失敗       → `{ error: "validation_failed", issues: [...] }`   (400)
 *
 * 各関数は成功時に typed data を、失敗時に組み立て済みの `Response` を返す discriminated
 * union を返す。caller は `if (!parsed.ok) return parsed.response;` の 1 行で narrow できる。
 */

/** parse 成功で typed data、失敗で組み立て済み 400 `Response` を返す共通の戻り値型。 */
type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

/** JSON parse 失敗の標準応答。`respondError(c, "invalid_body")` と byte 一致 (400 + `{error}`)。 */
function invalidBody(c: Context): Response {
  return c.json({ error: "invalid_body" }, StatusCodes.BAD_REQUEST);
}

/** Zod 検証失敗の標準応答。issues は Zod の生 issue 配列 (フロント契約なので整形しない)。 */
function validationFailed(c: Context, error: z.ZodError): Response {
  return c.json({ error: "validation_failed", issues: error.issues }, StatusCodes.BAD_REQUEST);
}

/**
 * JSON body を schema で検証する。
 * - JSON parse 失敗 → `invalid_body` (400)
 * - schema 不一致    → `validation_failed` + issues (400)
 * - 成功            → typed data
 */
export async function parseJsonBody<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): Promise<{ ok: true; data: z.infer<TSchema> } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: invalidBody(c) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, response: validationFailed(c, parsed.error) };
  return { ok: true, data: parsed.data };
}

/**
 * Query string を schema で検証する。失敗時は `validation_failed` (400)、成功時は typed object。
 */
export function parseQuery<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): { ok: true; data: z.infer<TSchema> } | { ok: false; response: Response } {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) return { ok: false, response: validationFailed(c, parsed.error) };
  return { ok: true, data: parsed.data };
}

/**
 * Path param を schema で検証する。失敗時は `validation_failed` (400)、成功時は typed object。
 */
export function parseParams<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): { ok: true; data: z.infer<TSchema> } | { ok: false; response: Response } {
  const parsed = schema.safeParse(c.req.param());
  if (!parsed.success) return { ok: false, response: validationFailed(c, parsed.error) };
  return { ok: true, data: parsed.data };
}

export type { ParseResult };
