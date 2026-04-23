/**
 * テナント分離ミドルウェア
 *
 * Hono ミドルウェアとして JWT からテナント ID を抽出し、
 * テナントコンテキストをリクエストに設定する。
 * すべての DB 操作でテナントアクセスが検証される。
 */
import { createMiddleware } from 'hono/factory';
import { StatusCodes } from 'http-status-codes';
import {
  withTenantContext,
  TenantContextError,
  type TenantContext,
} from '../tenant-context';

declare module 'hono' {
  interface ContextVariableMap {
    tenantContext: TenantContext;
  }
}

/**
 * テナント分離ミドルウェア
 * JWT の auth コンテキストからテナント ID を抽出し、
 * tenantContext 変数を設定する
 */
export const tenantIsolationMiddleware = createMiddleware(async (c, next) => {
  const auth = c.get('auth') as
    | { tenantId?: string; userId?: string }
    | undefined;

  if (!auth) {
    return c.json(
      { error: '認証コンテキストがありません' },
      StatusCodes.UNAUTHORIZED
    );
  }

  const tenantId = auth.tenantId;

  if (!tenantId) {
    return c.json(
      { error: 'テナント情報がありません' },
      StatusCodes.FORBIDDEN
    );
  }

  try {
    const context = withTenantContext(tenantId);
    c.set('tenantContext', context);
    await next();
  } catch (error) {
    if (error instanceof TenantContextError) {
      return c.json({ error: error.message }, StatusCodes.BAD_REQUEST);
    }
    throw error;
  }
});

/**
 * リクエストパラメータ内のテナント ID がコンテキストと一致するか検証するミドルウェア
 * URL パラメータやリクエストボディの tenantId を検証する
 */
export const validateTenantParamMiddleware = createMiddleware(
  async (c, next) => {
    const tenantContext = c.get('tenantContext') as TenantContext | undefined;

    if (!tenantContext) {
      return c.json(
        { error: 'テナントコンテキストがありません' },
        StatusCodes.INTERNAL_SERVER_ERROR
      );
    }

    // URL パラメータの tenantId を検証
    const paramTenantId = c.req.param('tenantId');
    if (paramTenantId && paramTenantId !== tenantContext.tenantId) {
      return c.json(
        { error: '別テナントのリソースにはアクセスできません' },
        StatusCodes.FORBIDDEN
      );
    }

    await next();
  }
);
