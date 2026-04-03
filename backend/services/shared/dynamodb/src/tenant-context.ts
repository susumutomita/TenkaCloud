/**
 * Tenant Context — マルチテナント分離のためのテナントコンテキスト管理
 *
 * Pool モデルでは、すべてのテナントが同一テーブルを共有するため、
 * パーティションキーにテナント ID を含めてデータを論理的に分離する。
 */

/** テナントコンテキストを表す型 */
export interface TenantContext {
  readonly tenantId: string;
}

/** テナントコンテキストのバリデーションエラー */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/** クロステナントアクセスエラー */
export class CrossTenantAccessError extends Error {
  constructor(requestTenantId: string, resourceTenantId: string) {
    super(
      `クロステナントアクセスが拒否されました: リクエストテナント=${requestTenantId}, リソーステナント=${resourceTenantId}`
    );
    this.name = 'CrossTenantAccessError';
  }
}

/**
 * テナントコンテキストを作成する
 * @param tenantId テナント ID
 * @returns TenantContext
 * @throws TenantContextError テナント ID が空の場合
 */
export function withTenantContext(tenantId: string): TenantContext {
  if (!tenantId || tenantId.trim() === '') {
    throw new TenantContextError('テナント ID が空です');
  }
  return { tenantId: tenantId.trim() };
}

/**
 * テナントアクセスを検証する
 * リクエスト元のテナント ID とリソースのテナント ID が一致することを確認する
 * @param requestTenantId リクエスト元のテナント ID
 * @param resourceTenantId リソースのテナント ID
 * @throws CrossTenantAccessError テナント ID が一致しない場合
 */
export function validateTenantAccess(
  requestTenantId: string,
  resourceTenantId: string
): void {
  if (!requestTenantId || requestTenantId.trim() === '') {
    throw new TenantContextError('リクエストテナント ID が空です');
  }
  if (!resourceTenantId || resourceTenantId.trim() === '') {
    throw new TenantContextError('リソーステナント ID が空です');
  }
  if (requestTenantId.trim() !== resourceTenantId.trim()) {
    throw new CrossTenantAccessError(requestTenantId, resourceTenantId);
  }
}

/**
 * テナントプレフィックス付きのパーティションキーを構築する
 * Pool モデルでは、PK に TENANT#<tenantId> プレフィックスを含める
 * @param context テナントコンテキスト
 * @param entityPrefix エンティティプレフィックス（例: "EVENT", "BATTLE"）
 * @param entityId エンティティ ID
 * @returns テナントスコープ付き PK
 */
export function buildTenantScopedKey(
  context: TenantContext,
  entityPrefix: string,
  entityId: string
): string {
  return `TENANT#${context.tenantId}#${entityPrefix}#${entityId}`;
}

/**
 * パーティションキーからテナント ID を抽出する
 * @param key パーティションキー
 * @returns テナント ID、抽出できない場合は null
 */
export function extractTenantIdFromKey(key: string): string | null {
  const match = key.match(/^TENANT#([^#]+)/);
  return match ? match[1] : null;
}
