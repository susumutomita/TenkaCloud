/**
 * Hono の `c.json(body, code)` で使う HTTP status codes の named constant。
 * 数値リテラル直書きを避けて意図を明示する (200 vs 202、400 vs 409 等の取り違え防止)。
 *
 * Hono の `ContentfulStatusCode` は number union なので as const で number 互換に保つ。
 */
export const HTTP_OK = 200 as const;
export const HTTP_CREATED = 201 as const;
export const HTTP_ACCEPTED = 202 as const;
export const HTTP_BAD_REQUEST = 400 as const;
export const HTTP_UNAUTHORIZED = 401 as const;
export const HTTP_NOT_FOUND = 404 as const;
export const HTTP_CONFLICT = 409 as const;
export const HTTP_INTERNAL_ERROR = 500 as const;
