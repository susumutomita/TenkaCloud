/**
 * Cloud Providers - Barrel Export
 */

export * from './interface';
export * from './factory';
export { AWSCloudProvider, getAWSProvider } from './aws';
export { LocalCloudProvider, getLocalProvider } from './local';

// プロバイダーの自動登録
import { CloudProviderFactory } from './factory';
import { AWSCloudProvider } from './aws';
import { LocalCloudProvider } from './local';

/**
 * デフォルトプロバイダーの登録
 */
export function registerDefaultProviders(): void {
  const factory = CloudProviderFactory.getInstance();

  // AWS プロバイダーの登録
  factory.registerProvider(new AWSCloudProvider());

  // ローカルプロバイダーの登録
  factory.registerProvider(new LocalCloudProvider());

  console.log(
    '[Providers] Registered default providers:',
    factory.getRegisteredProviders()
  );
}
