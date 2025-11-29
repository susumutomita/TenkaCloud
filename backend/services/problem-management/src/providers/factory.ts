/**
 * Cloud Provider Factory
 *
 * クラウドプロバイダーのインスタンスを管理するファクトリークラス
 */

import type { CloudProvider } from '../types';
import type { ICloudProvider, ICloudProviderFactory } from './interface';

/**
 * CloudProviderFactory
 *
 * シングルトンパターンでプロバイダーインスタンスを管理
 */
export class CloudProviderFactory implements ICloudProviderFactory {
  private static instance: CloudProviderFactory;
  private providers: Map<CloudProvider, ICloudProvider> = new Map();

  private constructor() {
    // プライベートコンストラクター（シングルトン）
  }

  /**
   * ファクトリーインスタンスの取得
   */
  static getInstance(): CloudProviderFactory {
    if (!CloudProviderFactory.instance) {
      CloudProviderFactory.instance = new CloudProviderFactory();
    }
    return CloudProviderFactory.instance;
  }

  /**
   * プロバイダーインスタンスの取得
   * @param provider プロバイダー識別子
   * @returns プロバイダーインスタンス
   * @throws Error 未登録のプロバイダーの場合
   */
  getProvider(provider: CloudProvider): ICloudProvider {
    const instance = this.providers.get(provider);
    if (!instance) {
      throw new Error(
        `Cloud provider '${provider}' is not registered. Available providers: ${this.getRegisteredProviders().join(', ')}`
      );
    }
    return instance;
  }

  /**
   * 登録済みプロバイダー一覧の取得
   */
  getRegisteredProviders(): CloudProvider[] {
    return Array.from(this.providers.keys());
  }

  /**
   * プロバイダーの登録
   * @param provider プロバイダーインスタンス
   */
  registerProvider(provider: ICloudProvider): void {
    if (this.providers.has(provider.provider)) {
      console.warn(
        `Cloud provider '${provider.provider}' is already registered. Overwriting.`
      );
    }
    this.providers.set(provider.provider, provider);
  }

  /**
   * プロバイダーの登録解除
   * @param provider プロバイダー識別子
   */
  unregisterProvider(provider: CloudProvider): void {
    this.providers.delete(provider);
  }

  /**
   * プロバイダーが登録されているか確認
   * @param provider プロバイダー識別子
   */
  hasProvider(provider: CloudProvider): boolean {
    return this.providers.has(provider);
  }

  /**
   * 全プロバイダーの登録解除（テスト用）
   */
  clearProviders(): void {
    this.providers.clear();
  }
}

/**
 * デフォルトのファクトリーインスタンスを取得
 */
export function getCloudProviderFactory(): CloudProviderFactory {
  return CloudProviderFactory.getInstance();
}

/**
 * プロバイダーを取得するヘルパー関数
 * @param provider プロバイダー識別子
 */
export function getCloudProvider(provider: CloudProvider): ICloudProvider {
  return getCloudProviderFactory().getProvider(provider);
}
