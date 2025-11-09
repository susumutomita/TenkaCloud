# Shared Services

Control Plane と Application Plane 両方から利用される共有ライブラリとユーティリティ。

## ディレクトリ構成

### cloud-abstraction/
マルチクラウド対応のための抽象化レイヤーです。

#### interfaces/
クラウドプロバイダー共通のインタフェース定義です。

- `IAuthProvider.ts`: 認証プロバイダーインタフェース
- `IStorageProvider.ts`: ストレージプロバイダーインタフェース
- `IComputeProvider.ts`: コンピュートプロバイダーインタフェース
- `IDatabaseProvider.ts`: データベースプロバイダーインタフェース

#### providers/
各クラウドプロバイダーの具体的な実装です。

- aws/: AWS 実装（Cognito, DynamoDB, EKS, etc.）
- gcp/: GCP 実装（将来実装）
- azure/: Azure 実装（将来実装）
- localstack/: LocalStack 実装（ローカル開発用）

## 設計原則

### 1. プロバイダー非依存
すべてのサービスはインタフェースを通じてクラウドリソースにアクセスし、特定のクラウドプロバイダーに依存しない設計とします。

### 2. Factory Pattern
環境変数（例: `TENKACLOUD_CLOUD_PROVIDER` の値: aws | gcp | azure | localstack）に基づいて、該当するプロバイダー実装を返す Factory パターンを使用します。

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
