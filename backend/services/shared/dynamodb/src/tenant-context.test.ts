import { describe, it, expect } from 'vitest';
import {
  withTenantContext,
  validateTenantAccess,
  buildTenantScopedKey,
  extractTenantIdFromKey,
  TenantContextError,
  CrossTenantAccessError,
} from './tenant-context';

describe('withTenantContext', () => {
  it('有効なテナント ID でコンテキストを作成すべき', () => {
    const context = withTenantContext('tenant-123');
    expect(context.tenantId).toBe('tenant-123');
  });

  it('テナント ID の前後の空白をトリムすべき', () => {
    const context = withTenantContext('  tenant-123  ');
    expect(context.tenantId).toBe('tenant-123');
  });

  it('空文字列の場合 TenantContextError をスローすべき', () => {
    expect(() => withTenantContext('')).toThrow(TenantContextError);
    expect(() => withTenantContext('')).toThrow('テナント ID が空です');
  });

  it('空白のみの場合 TenantContextError をスローすべき', () => {
    expect(() => withTenantContext('   ')).toThrow(TenantContextError);
  });
});

describe('validateTenantAccess', () => {
  it('同一テナント ID の場合はエラーをスローしないべき', () => {
    expect(() =>
      validateTenantAccess('tenant-123', 'tenant-123')
    ).not.toThrow();
  });

  it('異なるテナント ID の場合 CrossTenantAccessError をスローすべき', () => {
    expect(() =>
      validateTenantAccess('tenant-123', 'tenant-456')
    ).toThrow(CrossTenantAccessError);
  });

  it('クロステナントエラーに両方のテナント ID を含めるべき', () => {
    try {
      validateTenantAccess('tenant-123', 'tenant-456');
    } catch (error) {
      expect(error).toBeInstanceOf(CrossTenantAccessError);
      expect((error as Error).message).toContain('tenant-123');
      expect((error as Error).message).toContain('tenant-456');
    }
  });

  it('リクエストテナント ID が空の場合 TenantContextError をスローすべき', () => {
    expect(() => validateTenantAccess('', 'tenant-456')).toThrow(
      TenantContextError
    );
    expect(() => validateTenantAccess('', 'tenant-456')).toThrow(
      'リクエストテナント ID が空です'
    );
  });

  it('リソーステナント ID が空の場合 TenantContextError をスローすべき', () => {
    expect(() => validateTenantAccess('tenant-123', '')).toThrow(
      TenantContextError
    );
    expect(() => validateTenantAccess('tenant-123', '')).toThrow(
      'リソーステナント ID が空です'
    );
  });

  it('前後の空白を無視して比較すべき', () => {
    expect(() =>
      validateTenantAccess('  tenant-123  ', '  tenant-123  ')
    ).not.toThrow();
  });
});

describe('buildTenantScopedKey', () => {
  it('テナントスコープ付きキーを構築すべき', () => {
    const context = withTenantContext('tenant-123');
    const key = buildTenantScopedKey(context, 'EVENT', 'event-456');
    expect(key).toBe('TENANT#tenant-123#EVENT#event-456');
  });

  it('異なるエンティティプレフィックスに対応すべき', () => {
    const context = withTenantContext('tenant-abc');
    expect(buildTenantScopedKey(context, 'BATTLE', 'bat-1')).toBe(
      'TENANT#tenant-abc#BATTLE#bat-1'
    );
    expect(buildTenantScopedKey(context, 'SCORING', 'scr-1')).toBe(
      'TENANT#tenant-abc#SCORING#scr-1'
    );
  });
});

describe('extractTenantIdFromKey', () => {
  it('テナントスコープキーからテナント ID を抽出すべき', () => {
    expect(extractTenantIdFromKey('TENANT#tenant-123#EVENT#event-456')).toBe(
      'tenant-123'
    );
  });

  it('シンプルなテナントキーからテナント ID を抽出すべき', () => {
    expect(extractTenantIdFromKey('TENANT#tenant-123')).toBe('tenant-123');
  });

  it('テナントプレフィックスがない場合 null を返すべき', () => {
    expect(extractTenantIdFromKey('EVENT#event-456')).toBeNull();
  });

  it('空文字列の場合 null を返すべき', () => {
    expect(extractTenantIdFromKey('')).toBeNull();
  });
});
