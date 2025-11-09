# Shared Services

Control PlaneとApplication Plane両方から利用される共有ライブラリとユーティリティ。

## ディレクトリ構成

### cloud-abstraction/
マルチクラウド対応のための抽象化レイヤー

#### interfaces/
クラウドプロバイダー共通のインターフェース定義

- `IAuthProvider.ts`: 認証プロバイダーインターフェース
- `IStorageProvider.ts`: ストレージプロバイダーインターフェース
- `IComputeProvider.ts`: コンピュートプロバイダーインターフェース
- `IDatabaseProvider.ts`: データベースプロバイダーインターフェース

#### providers/
各クラウドプロバイダーの具体的な実装

- aws/: AWS実装（Cognito, DynamoDB, EKS, etc.）
- gcp/: GCP実装（将来実装）
- azure/: Azure実装（将来実装）
- localstack/: LocalStack実装（ローカル開発用）

## 設計原則

### 1. プロバイダー非依存
すべてのサービスはインターフェースを通じてクラウドリソースにアクセスし、特定のクラウドプロバイダーに依存しない設計とします。

### 2. Factory Pattern
環境変数に基づいて適切なプロバイダー実装を返すFactoryパターンを使用します。

```typescript
// 例
const authProvider = CloudProviderFactory.getAuthProvider();
const user = await authProvider.createUser(userData);
```

### 3. 環境別設定
- production: AWS
- development: LocalStack
- test: Mock Provider

## 利用方法

```typescript
import { CloudProviderFactory } from '@tenkacloud/shared/cloud-abstraction';

// 認証プロバイダーを取得
const authProvider = CloudProviderFactory.getAuthProvider();

// ストレージプロバイダーを取得
const storageProvider = CloudProviderFactory.getStorageProvider();
```

## 今後の拡張

- メトリクス収集ライブラリ
- ログ集約ユーティリティ
- 共通バリデーション関数
- 共通エラーハンドリング
- テナントコンテキスト管理
