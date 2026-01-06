/**
 * テナントコンテキスト
 *
 * Application Plane 全体でテナント情報を共有するための React Context
 */

'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * ユーザーロール
 */
export type UserRole = 'admin' | 'participant';

/**
 * テナント情報
 */
export interface TenantInfo {
  /**
   * テナントスラッグ（URL識別子）
   */
  slug: string | null;

  /**
   * テナント ID（Auth0 Organization ID など）
   */
  tenantId?: string;

  /**
   * テナント名
   */
  tenantName?: string;

  /**
   * テナントティア
   */
  tier?: 'FREE' | 'PRO' | 'ENTERPRISE';

  /**
   * ユーザーのロール（admin または participant）
   */
  userRole?: UserRole;

  /**
   * ロード中フラグ
   */
  isLoading: boolean;

  /**
   * エラーメッセージ
   */
  error?: string;
}

/**
 * デフォルトのテナント情報
 */
const defaultTenantInfo: TenantInfo = {
  slug: null,
  isLoading: true,
};

/**
 * テナントコンテキスト
 */
const TenantContext = createContext<TenantInfo | null>(null);

/**
 * テナントコンテキストプロバイダーの Props
 */
interface TenantProviderProps {
  children: ReactNode;
  initialTenant?: TenantInfo;
}

/**
 * テナントコンテキストプロバイダー
 *
 * middleware でテナント情報を取得し、サーバーコンポーネントから
 * クライアントコンポーネントに渡すために使用
 */
export function TenantProvider({
  children,
  initialTenant = defaultTenantInfo,
}: TenantProviderProps) {
  return (
    <TenantContext.Provider value={initialTenant}>
      {children}
    </TenantContext.Provider>
  );
}

/**
 * テナント情報を取得するフック
 *
 * @throws TenantProvider 外で使用された場合
 */
export function useTenant(): TenantInfo {
  const context = useContext(TenantContext);

  if (context === null) {
    throw new Error('useTenant must be used within a TenantProvider');
  }

  return context;
}

/**
 * テナント情報を取得するフック（オプショナル版）
 *
 * TenantProvider 外でも使用可能（null を返す）
 */
export function useTenantOptional(): TenantInfo | null {
  return useContext(TenantContext);
}
