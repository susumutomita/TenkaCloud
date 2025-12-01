# TenkaCloud — The Open Cloud Battle Arena

## 🎯 プロジェクト概要

TenkaCloud は、クラウド技術者のための常設・オープンソースの競技プラットフォームです。AWS GameDay 文化をルーツに、完全スクラッチで再構築された OSS 版クラウド天下一武道会のプラットフォームとして作っています。

## 🏯 コンセプト

世界中のクラウド戦士たちが集い、技を磨き、腕を競い、学び合う常設の天下一武道会。

### コアバリュー

- 🧱 完全 OSS 実装 — 社内資産を含まず、ゼロから再設計
- ☁️ マルチクラウド対応 — AWS / GCP / Azure / LocalStack / OCI
- 🏗 マルチテナント SaaS 構造 — 常設・チーム対戦・観戦モード
- ⚔️ 問題互換設計 — 既存 Cloud Contest 問題を再利用可能
- 🧠 AI 支援機能 — 問題生成・自動採点・コーチング（MCP/Claude Code 対応）

## 🛠 技術スタック

### フロントエンド

- Next.js (App Router) - メインフレームワーク
- TypeScript - 型安全性の確保
- Tailwind CSS - スタイリング
- React - UI 構築

### バックエンド

- AWS EKS - Kubernetes クラスター（参考: [AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)）
- マルチテナントアーキテクチャ - テナント分離とリソース管理
- マイクロサービス - スケーラブルなサービス設計

### インフラストラクチャ

- Kubernetes - コンテナオーケストレーション
- Docker - コンテナ化
- Terraform - マルチクラウド対応

### リファレンス

- [SaaS Amazon EKS Reference Architecture](./reference/eks)が参考になるのでコントロールプレーンの設計はこれを参考にする。

### AI/メーリングリスト機能

- Claude API - AI 支援機能
- MCP (Model Context Protocol) - AI 統合
- 自動採点システム - インフラ構築の自動評価

## アーキテクチャ設計

### 参考アーキテクチャ

本プロジェクトは、[AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)を参考にし、以下の点を採用・拡張します。

1. マルチテナント SaaS 構造

   - テナント分離戦略
   - リソースプール管理
   - テナントごとの独立した環境
2. Cloud Agnostic のマイクロサービス

   - Kubernetes ネイティブな設計
   - スケーラブルなサービス構成
   - サービスメッシュ
3. セキュリティとアイデンティティ

   - テナントレベルのアクセス制御
   - セキュアな API 設計

### TenkaCloud固有の拡張

1. マルチクラウド対応

   - AWS 以外のクラウドプロバイダー（GCP、Azure、OCI）への対応
   - LocalStack によるローカル開発環境
   - クラウドプロバイダー間の抽象化レイヤー
2. 競技プラットフォーム機能

   - リアルタイムバトル管理
   - チーム対戦システム
   - 観戦モード（リアルタイム進捗表示）
   - リーダーボード
3. 問題管理システム

   - Cloud Contest 問題形式との互換性
   - 問題テンプレートシステム
   - 動的問題生成（AI 支援）
4. 自動採点・評価システム

   - インフラ構築の自動検証
   - コスト最適化スコアリング
   - セキュリティベストプラクティス評価
   - パフォーマンス評価

## 🏗 プロジェクト構造

```text
TenkaCloud/
├── frontend/              # Next.jsアプリケーション
│   ├── app/              # App Router
│   ├── components/       # Reactコンポーネント
│   ├── lib/              # ユーティリティ
│   └── styles/           # スタイル
├── backend/              # バックエンドサービス
│   ├── api/              # APIサービス
│   ├── auth/             # 認証サービス
│   ├── tenant/           # テナント管理
│   ├── battle/           # バトル管理
│   └── scoring/          # 採点システム
├── infrastructure/       # インフラストラクチャコード
│   ├── k8s/              # Kubernetesマニフェスト
│   └── terraform/        # Terraform（マルチクラウド用）
├── problems/             # 問題定義
│   ├── templates/        # 問題テンプレート
│   └── examples/         # サンプル問題
├── ai/                   # AI機能
│   ├── problem-generator/ # 問題生成
│   ├── scoring/          # 自動採点
│   └── coaching/         # コーチング機能
└── docs/                 # ドキュメント
```

## 🚀 主要機能

### 1. バトルアリーナ

- リアルタイムバトルセッション
- チーム対戦モード
- 観戦モード（リアルタイム進捗表示）
- バトル履歴とリプレイ

### 2. 問題管理

- 問題ライブラリ
- 問題作成・編集（AI 支援）
- Open Cloud Contest 形式と互換性
- カスタム問題作成

### 3. 自動採点システム

- インフラ構築の自動検証
- コスト最適化スコアリング
- セキュリティ評価
- パフォーマンス評価
- 詳細なフィードバック

### 4. AI支援機能

- 問題生成: AI による問題自動生成
- 自動採点: インフラ構築の自動評価
- コーチング: リアルタイムヒントとアドバイス
- MCP/Claude Code 統合: 開発者体験の向上

### 5. マルチテナント管理

- テナント登録・管理
- リソース分離
- 使用量追跡
- 課金管理（将来実装）

### 6. リーダーボード

- グローバルランキング
- カテゴリ別ランキング
- チームランキング
- 統計情報

## セキュリティ設計

- テナント分離: 完全なリソース分離
- IAM 統合: AWS IAM ベースの認証・認可
- ネットワーク分離: VPC、セキュリティグループ
- データ暗号化: 転送時・保存時の暗号化
- 監査ログ: 全アクションの記録

## マルチクラウド対応戦略

1. 抽象化レイヤー

   - クラウドプロバイダー固有の実装を抽象化
   - 統一された API インタフェース
2. プロバイダーアダプター

   - AWS Adapter
   - GCP Adapter
   - Azure Adapter
   - OCI Adapter
   - LocalStack Adapter（開発用）
3. リソースマッピング

   - 各クラウドプロバイダーのリソースを統一モデルにマッピング

## 🧪 開発環境

### ローカル開発

- LocalStack を使用した AWS エミュレーション
- Docker Compose によるローカル Kubernetes
- Next.js 開発サーバー

### テスト環境

- EKS クラスター（開発用）
- CI/CD パイプライン
- 自動テストスイート

## 📝 開発ガイドライン

### コーディング規約

- TypeScript strict mode
- ESLint + Prettier
- コンポーネント駆動開発
- テスト駆動開発（TDD）

### Gitワークフロー

- 機能ブランチ戦略
- プルリクエストベースのレビュー
- セマンティックバージョニング

## 🎓 学習リソース

- [AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)
- Kubernetes 公式ドキュメント
- Next.js 公式ドキュメント
- AWS CDK 公式ドキュメント

## 🤝 コントリビューション

本プロジェクトは完全オープンソースです。コントリビューションを歓迎します。

1. Issue を作成して機能提案・バグ報告
2. Fork してブランチを作成
3. 変更をコミット
4. プルリクエストを送信

## 📄 ライセンス

MIT License（予定）

## 🔮 ロードマップ

### Phase 1: 基盤構築

- [ ] Next.js プロジェクトセットアップ
- [ ] AWS EKS クラスター構築
- [ ] 基本的なマルチテナント構造
- [ ] 認証・認可システム

### Phase 2: コア機能

- [ ] バトルアリーナ機能
- [ ] 問題管理システム
- [ ] 基本的な採点システム

### Phase 3: AI統合

- [ ] AI 問題生成
- [ ] 自動採点システム
- [ ] コーチング機能

### Phase 4: マルチクラウド対応

- [ ] GCP 対応
- [ ] Azure 対応
- [ ] OCI 対応
- [ ] LocalStack 統合

### Phase 5: 高度な機能

- [ ] 観戦モード
- [ ] リーダーボード
- [ ] 統計・分析機能

---

## 🤖 Claude Agent 開発プレイブック

このセクションは、Claude Code や AI エージェントが自律的に開発を進めるためのガイドラインです。

### 開発の基本原則

#### 1. 実装方針

- **動くものをイテレーティブに作る**: 完璧を目指さず、小さく動くものを素早く作り、段階的に改善する
- **Plan.md でプロセスを記録**: すべての意思決定、実装内容、振り返りを `Plan.md` に記録する
- **テスト駆動開発 (TDD)**: コードを書く前にテストを書く（t-wada スタイル）
- **カバレッジ 100%**: すべてのコードパスをテストでカバーする
- **BDD スタイルのテスト**: テストは振る舞いを記述し、テストタイトルは日本語で書く

#### 1.4 ドキュメント作成方針

- 文末は「」で終える。コロンや記号で文を終わらせない。
- 日本語と半角英数字の間には半角スペースを入れ、全角・半角の混在を避ける。
- 見出しや箇条書きでは過度な装飾をしない。絵文字と太字の併用は避け、簡潔に書く。
- 技術用語・記号は原語を保ちつつ、日本語文脈に合わせて表記ゆれをなくす（例: 100％ と表記する）。
- lint/textlint は最終安全網と位置づけ、執筆時点で上記ルールを意識してエラーを作らないことを優先する。

#### 2. プロダクションレディ実装原則

**CRITICAL**: モックアップレベルではなく、プロダクションレベルのコードを一発で作成する。

##### 2.1. No Mock, No Stub - 実装する時は本物を作る

- 禁止: モックデータ、ハードコードされた配列、スタブ API
- 必須: 実際のデータベース接続、実際の API 統合、実際のファイル I/O
- NG 例: `const tenants = [{ id: 1, name: "Mock" }]`
- OK 例: `const tenants = await db.query('SELECT * FROM tenants')`

##### 2.2. フルスタック一気通貫実装

新機能を実装する際は、次の 5 つをまとめて実装する。

1. **データモデル** (Database Schema)
   - マイグレーションファイル作成
   - テーブル・インデックス定義
   - リレーション設定

2. **バックエンド API** (Fastify/Express)
   - ルート定義
   - バリデーション（Zod/Joi）
   - ビジネスロジック
   - エラーハンドリング
   - ログ記録

3. **フロントエンド** (Next.js)
   - ページ・コンポーネント
   - Server Actions / API 呼び出し
   - フォームバリデーション
   - エラー表示
   - ローディング状態

4. **認証・認可**
   - Keycloak ロール設定
   - アクセス制御ロジック
   - セッション管理

5. **テスト** (カバレッジ １００％)
   - ユニットテスト（全関数）
   - 統合テスト（API エンドポイント）
   - E2E テスト（ユーザーフロー）

##### 2.3. 実装必須チェックリスト

**すべての新機能実装時に確認**:

- [ ] **データ永続化**: データベースに実際に保存・取得している
- [ ] **認証・認可**: Keycloak でアクセス制御を実装している
- [ ] **入力バリデーション**: すべての入力をサーバーサイドで検証している
- [ ] **エラーハンドリング**: try-catch、エラー境界、ユーザーへのエラー表示
- [ ] **ログ記録**: 重要なイベント、エラーをログに記録している
- [ ] **セキュリティ**: OWASP Top 10 対策（SQLi、XSS、CSRF、認証・認可）
- [ ] **テストカバレッジ 100%**: すべてのコードパスをテストでカバー
- [ ] **型安全性**: TypeScript strict mode で型エラーなし
- [ ] **ドキュメント**: API ドキュメント、コメント、README 更新

##### 2.4. NG 実装パターン（絶対に避ける）

```typescript
// ❌ NG: モックデータを返す
export async function getTenants() {
  return [
    { id: 1, name: "Tenant 1" },
    { id: 2, name: "Tenant 2" }
  ];
}

// ❌ NG: バリデーションなし
export async function createTenant(data: any) {
  return await db.insert(data); // 危険！
}

// ❌ NG: エラーハンドリングなし
export async function updateTenant(id: string, data: any) {
  const result = await db.update(id, data);
  return result;
}

// ❌ NG: 認証チェックなし
export async function deleteTenant(id: string) {
  await db.delete(id); // 誰でも削除できてしまう！
}
```

##### 2.5. OK 実装パターン（プロダクションレディ）

```typescript
// ✅ OK: 実際のデータベース接続
export async function getTenants(session: Session) {
  // 認証チェック
  if (!session?.user?.roles?.includes('platform-admin')) {
    throw new UnauthorizedError('Platform admin access required');
  }

  try {
    // 実際のデータベースクエリ
    const tenants = await db.query(
      'SELECT * FROM tenants WHERE deleted_at IS NULL ORDER BY created_at DESC'
    );

    // ログ記録
    logger.info('Tenants retrieved', {
      userId: session.user.id,
      count: tenants.length
    });

    return tenants;
  } catch (error) {
    // エラーハンドリング
    logger.error('Failed to retrieve tenants', { error });
    throw new DatabaseError('Failed to retrieve tenants', { cause: error });
  }
}

// ✅ OK: バリデーション、エラーハンドリング、認証
export async function createTenant(
  data: unknown,
  session: Session
): Promise<Tenant> {
  // 認証チェック
  if (!session?.user?.roles?.includes('platform-admin')) {
    throw new UnauthorizedError('Platform admin access required');
  }

  // バリデーション
  const validated = TenantSchema.parse(data);

  try {
    // トランザクション内で実行
    const tenant = await db.transaction(async (tx) => {
      // Keycloak Realm 作成
      const realm = await keycloak.createRealm({
        realm: validated.slug,
        enabled: true
      });

      // テナントレコード作成
      const tenant = await tx.insert('tenants', {
        ...validated,
        keycloak_realm_id: realm.id,
        created_by: session.user.id
      });

      return tenant;
    });

    // ログ記録
    logger.info('Tenant created', {
      tenantId: tenant.id,
      userId: session.user.id
    });

    return tenant;
  } catch (error) {
    logger.error('Failed to create tenant', { error, data: validated });
    throw new TenantCreationError('Failed to create tenant', { cause: error });
  }
}
```

##### 2.6. 実装順序（TDD 維持）

プロダクションレディでも TDD は維持する。

1. **テストファースト**: 失敗するテストを先に書く
2. **最小実装**: テストを通す最小限のプロダクションコードを書く
3. **リファクタリング**: コードをクリーンアップ
4. **次の機能**: 次のテストを書いて繰り返し

注意:「最小実装」であっても、モックではなく実際の実装を書く。

##### 2.7. レビュー時の確認ポイント

プルリクエスト作成前に自己レビューする。

- [ ] モックデータやスタブが残っていないか
- [ ] すべての API が実際のデータベースに接続しているか
- [ ] 認証・認可チェックがすべてのエンドポイントにあるか
- [ ] バリデーションがサーバーサイドで実装されているか
- [ ] エラーハンドリングが適切に実装されているか
- [ ] ログが適切に記録されているか
- [ ] テストカバレッジが 100％ か
- [ ] 型エラーがないか（TypeScript strict mode）
- [ ] セキュリティ脆弱性がないか（OWASP Top 10）

#### 3. ユビキタス言語（Ubiquitous Language）

プロジェクト全体で統一して使用する用語です。

**テナント関連**

- **テナント (Tenant)**: TenkaCloud を利用する組織・企業単位
- **テナント ID (Tenant ID)**: テナントを一意に識別する ID
- **Control Plane**: テナント管理・認証を担う共有プラットフォーム
- **Application Plane**: テナント固有のビジネスロジックを実行するサービス群

**バトル関連**

- **バトル (Battle)**: クラウド構築の競技セッション
- **バトルセッション**: 時間制限付きの競技インスタンス
- **参加者 (Participant)**: バトルに参加する競技者
- **観戦者 (Spectator)**: バトルをリアルタイムで観戦するユーザー

**問題関連**

- **問題 (Problem)**: クラウドインフラ構築の課題
- **問題テンプレート (Problem Template)**: 再利用可能な問題の雛形
- **採点基準 (Scoring Criteria)**: インフラ評価の基準（機能性、コスト、セキュリティ、パフォーマンス）

**ユーザー関連**

- **プラットフォーム管理者 (Platform Admin)**: TenkaCloud 全体を管理する運営者
- **テナント管理者 (Tenant Admin)**: テナント内のユーザー・バトルを管理する管理者
- **競技者 (Competitor)**: バトルに参加してインフラを構築するユーザー

### Plan.md 運用ルール

#### Plan.md の構成

```markdown
# TenkaCloud Development Plan

## 実行計画 (Exec Plans)

### [機能名] - [日付]

**目的 (Objective)**:
- 何を達成するか

**制約 (Guardrails)**:
- 守るべきルール・制約

**タスク (TODOs)**:
- [ ] タスク 1
- [ ] タスク 2

**検証手順 (Validation)**:
- テスト実行方法
- 確認すべき項目

**未解決の質問 (Open Questions)**:
- 調査が必要な項目

**進捗ログ (Progress Log)**:
- [YYYY-MM-DD HH:MM] 実施内容と結果

**振り返り (Retrospective)**:
- 問題: 何が起きたか
- 根本原因: なぜ起きたか
- 予防策: 今後どう防ぐか
```

#### Plan.md 更新ルール

1. **コードを書く前に実行計画を作成**
2. **進捗ログにタイムスタンプ付きで記録**（決して削除しない）
3. **問題が起きたら必ず振り返りを書く**
4. **コミットメッセージで Plan.md の該当セクションを参照**

### テスト駆動開発 (TDD) プロトコル

#### テストファースト原則

```typescript
// ❌ NG: いきなりコードを書く
export function calculateScore(infraConfig: InfraConfig): number {
  // ...
}

// ✅ OK: まずテストを書く
describe('採点システム', () => {
  describe('calculateScore', () => {
    it('完全に要件を満たすインフラ構成は 100 点を返すべき', () => {
      const config: InfraConfig = {
        // テストデータ
      };
      expect(calculateScore(config)).toBe(100);
    });

    it('セキュリティ要件を満たさない場合は減点されるべき', () => {
      const insecureConfig: InfraConfig = {
        // セキュリティ問題のあるテストデータ
      };
      expect(calculateScore(insecureConfig)).toBeLessThan(100);
    });
  });
});
```

#### BDD スタイルのテスト記述

- **describe**: 対象の機能・クラス・関数を日本語で記述
- **it/test**: 期待する振る舞いを「〜すべき」形式で日本語記述
- **Given-When-Then** パターンを意識

```typescript
describe('テナント管理サービス', () => {
  describe('createTenant', () => {
    it('有効なテナント情報を渡すと新しいテナントが作成されるべき', async () => {
      // Given: 有効なテナント情報
      const tenantData = {
        name: 'Test Org',
        adminEmail: 'admin@test.com'
      };

      // When: テナント作成を実行
      const tenant = await createTenant(tenantData);

      // Then: テナントが正常に作成される
      expect(tenant.id).toBeDefined();
      expect(tenant.name).toBe('Test Org');
      expect(tenant.status).toBe('active');
    });
  });
});
```

### 自律開発フロー

Claude Code や AI エージェントが自律的に開発を進める際のワークフローです。

#### 1. 分析 & 計画 (Analyze & Plan)

- 次に実装すべき機能を GitHub Issue から特定
- `Plan.md` に実行計画を作成（目的、制約、TODO、検証手順）
- TodoWrite で実装ステップを追跡

#### 2. テストファースト実装 (Test-First Implementation)

- **Red**: まず失敗するテストを書く
- **Green**: テストを通す最小限のコードを書く
- **Refactor**: コードをクリーンアップ
- `Plan.md` の進捗ログを更新

#### 3. 検証 (Validation)

**CRITICAL: タスク完了の必須条件**

すべてのタスク完了時に必ず `make before-commit` を実行し、成功することを確認する。これはタスク完了の必須条件であり、このコマンドが成功しない限りタスクは完了とみなさない。

```bash
# 必須: タスク完了前に必ず実行
make before-commit
```

このコマンドは以下をすべて実行する。
- `lint_text`: テキストの lint チェック
- `format_check`: コードフォーマットチェック
- `typecheck`: 全フロントエンドアプリの型チェック
- `test`: 全フロントエンドアプリのテスト（カバレッジ 99％以上必須）
- `build`: 全フロントエンドアプリのビルド

**すべて Green にならない限りタスクは完了とみなさない。失敗したら Plan.md に問題を記録。**

#### 4. Git ワークフロー

```bash
# 1. 最新の main をベースにする
git fetch origin main
git rebase origin/main

# 2. 機能ブランチを作成
git checkout -b feat/descriptive-name

# 3. 関連ファイルのみステージング
git add [files]

# 4. Conventional Commits 形式でコミット
git commit -m "feat: 簡潔な説明

- 変更内容の箇条書き
- 技術的な判断
- 現在の状態

Refs: Plan.md \"実行計画名\"

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
"

# 5. プッシュ前に再度 rebase（main が進んでいる場合）
git fetch origin main
git rebase origin/main
git push -u origin feat/branch-name
```

**Issue 引用のルール:**
- **コミットメッセージや PR 本文で他の Issue を `#番号` 形式で引用しない**
- 理由: GitHub が自動的に相互リンクを作成し、関連 Issue にノイズが発生するため
- 代替: Issue 番号を言及する必要がある場合は、フル URL（`https://github.com/org/repo/issues/番号`）を使用するか、番号のみ（`Issue 番号`）で記述する

#### 5. プルリクエスト作成

```bash
# GitHub CLI でプルリクエスト作成
gh pr create --title "feat: 機能名" --body "
## 概要
何を実装したか

## 変更内容
- [ ] 変更 1
- [ ] 変更 2

## テスト
- [ ] ユニットテスト（カバレッジ 100%）
- [ ] 型チェック通過
- [ ] ビルド成功

## 参照
- Plan.md の該当セクション
- 関連 Issue 番号（#を付けない）
"
```

#### 6. CI 検証 (CRITICAL)

**プルリクエスト作成後、必ず CI 状態を確認：**

```bash
# CI ステータス確認
gh pr checks <PR番号>

# 失敗している場合、ログ取得
gh run view <RUN_ID> --log-failed

# 修正して同じブランチに push
git add .
git commit -m "fix: CI エラー修正 - [説明]"
git push
```

**CI が Green になるまで次に進まない。**

#### 7. 振り返り & 改善プロトコル

**問題が起きたら必ず振り返りを `Plan.md` に記録：**

```markdown
##### 問題 (Problem)
何が起きたか（具体的に）

##### 根本原因 (Root Cause)
なぜ起きたか（技術的・プロセス的）

##### 予防策 (Prevention)
- CLAUDE.md に追加すべきルール
- 自動化できるチェック
- ドキュメント更新
```

### カバレッジ 100％ の実現方法

#### カバレッジ計測

```bash
# ni を使用（推奨）
nr test:coverage

# または直接実行
bun run test:coverage
```

#### カバレッジレポートの確認

```
-----------------------|---------|----------|---------|---------|-------------------
File                   | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-----------------------|---------|----------|---------|---------|-------------------
All files              |   100   |   100    |   100   |   100   |
 src/                  |   100   |   100    |   100   |   100   |
  tenant-service.ts    |   100   |   100    |   100   |   100   |
-----------------------|---------|----------|---------|---------|-------------------
```

**100％ 未満の場合:**

1. Uncovered Line #s を確認
2. 該当行をカバーするテストを追加
3. 再度計測して 100％ になるまで繰り返す

### セルフレビュープロトコル

**プルリクエストを「完了」と報告する前に必ず実行：**

```bash
# プルリクエストの diff を確認
gh pr diff <PR番号>
```

**セルフレビューチェックリスト:**

- [ ] コードがプロジェクトのスタイルに従っている
- [ ] すべての検証チェックが通過（lint, typecheck, test, build）
- [ ] コメントアウトされたコードやデバッグ文がない
- [ ] エラーハンドリングが適切
- [ ] ドキュメントが更新されている
- [ ] Plan.md が実装内容を正確に反映
- [ ] コミットメッセージが明確
- [ ] **CI が Green**

### ハンドオフプロトコル

人間のレビュアーに引き継ぐ際に確認すべき項目です。

1. **Plan.md に最終状態を記録**:

   - 完了した作業
   - 未解決の問題・リスク
   - 次のステップ
   - 最新のテスト状態
2. **プルリクエストに明確な情報**:

   - Plan.md へのリンク
   - 検証エビデンス（テスト結果、ビルド成功）
   - レビュー時の注意点
3. **CI が Green になっていることを確認**
4. **セルフレビュー完了**

**これらがすべて揃って初めて、人間のレビューを依頼できる。**

---

## 📞 連絡先

- GitHub Issues: 機能提案・バグ報告
- Discussions: 技術的な議論

<!-- Added by Repository Hooks (2025-11-23 08:20) -->

## 環境構築とバージョン管理
### Docker と ローカル環境のバージョン統一
- 必須事項: Dockerfile で使用する言語ランタイム（Bun、Node.js 等）のバージョンをローカル環境と可能な限り一致させる
- **lockfile の整合性**: バージョン不一致により lockfile エラーが発生するため、明示的にバージョンを固定する
例として次を使用する。
```dockerfile
# ❌ NG: バージョンを指定しない
FROM oven/bun:latest
# ✅ OK: ローカル環境と同じバージョンを明示
FROM oven/bun:1.2.20
```
## NextAuth + Keycloak 統合パターン
### ログアウト処理のベストプラクティス
- **問題**: `signOut()` 実行後、セッションがクリアされるため `idToken` が `undefined` になり、Keycloak への `id_token_hint` パラメータが渡せない
- **解決**: `signOut()` 実行**前**に必要なセッションデータを変数に保存する
**実装例**:
```typescript
// ✅ OK: signOut前にidTokenを保存
const currentSession = await auth();
const idToken = currentSession?.idToken;
const keycloakIssuer = process.env.AUTH_KEYCLOAK_ISSUER;
await signOut({ redirect: false });
if (idToken && keycloakIssuer) {
  // 保存したidTokenを使用してKeycloakログアウト
  const logoutUrl = `${keycloakIssuer}/protocol/openid-connect/logout?id_token_hint=${idToken}&post_logout_redirect_uri=${encodedRedirectUri}`;
  redirect(logoutUrl);
}
// ❌ NG: signOut後にidTokenを取得しようとする
await signOut({ redirect: false });
const currentSession = await auth(); // セッションは既にクリア済み
if (currentSession?.idToken) { // undefined になる
  // ...
}
```
## Issue 管理ポリシー
### Issue クローズの基準
- **受け入れ基準 (Acceptance Criteria) をすべて満たした場合のみクローズ**
- 部分実装の場合は Issue を開いたまま保持し、進捗をコメントで記録
- マイルストーンを活用して MVP フェーズと Full Feature フェーズを区別
## ローカル開発体験 (DX) 標準
### make start コマンドの要件
- **すべてのサービスが一度に起動する**: フロントエンド（Control Plane UI、Admin App、Participant App、Landing Page）、バックエンド、認証基盤（Keycloak）
- **ローカルでの動作確認が容易**: 開発者が個別にサービスを起動する手間を省く
- **ポート番号の明示**: README または Makefile に各サービスのポート番号を記載

## ni (パッケージマネージャー自動選択ツール)

本プロジェクトでは [@antfu/ni](https://github.com/antfu-collective/ni) を使用し、パッケージマネージャーに依存しないコマンド体系を採用している。

### ni コマンド対応表

| ni コマンド | 本プロジェクトでの変換結果（bun） | 用途 |
|------------|----------------------------------|------|
| `ni` | `bun install` | 依存関係をインストール |
| `ni <pkg>` | `bun add <pkg>` | パッケージを追加 |
| `ni -D <pkg>` | `bun add -D <pkg>` | devDependencies に追加 |
| `nr <script>` | `bun run <script>` | スクリプトを実行 |
| `nlx <pkg>` | `bunx <pkg>` | パッケージを一時実行 |
| `nci` | `bun install --frozen-lockfile` | CI 用クリーンインストール |
| `nun <pkg>` | `bun remove <pkg>` | パッケージを削除 |
| `nup` | `bun update` | パッケージを更新 |

### 推奨コマンド例

```bash
# 依存関係のインストール
ni

# 開発サーバー起動
nr dev

# テスト実行
nr test

# テストカバレッジ
nr test:coverage

# ビルド
nr build

# 型チェック
nr typecheck
```

### 利点
- lock ファイル（bun.lockb）を検出して自動的に bun を使用する
- 新規参加者が「npm i in a bun project」のような間違いを防げる
- CI/CD やドキュメントでパッケージマネージャーを統一できる

## フロントエンドデザインスキル

このスキルは、ジェネリックな「AI 風」デザインを避け、プロダクショングレードで独自性のあるフロントエンドインタフェースを作成するためのガイドラインです。

### デザイン思考

コーディング前に、コンテキストを理解し、大胆な美的方向性にコミットする。

- **目的**: このインタフェースはどんな問題を解決するか。誰が使うか。
- **トーン**: 極端な方向性を選ぶ。ブルータルミニマル、マキシマリストカオス、レトロフューチャリスティック、オーガニック/ナチュラル、ラグジュアリー/リファインド、プレイフル/トイライク、エディトリアル/マガジン、ブルータリスト/ロー、アールデコ/ジオメトリック、ソフト/パステル、インダストリアル/ユティリタリアン等。
- **制約**: 技術的要件（フレームワーク、パフォーマンス、アクセシビリティ）。
- **差別化**: 何がこれを忘れられないものにするか。ユーザーが記憶に残す一点は何か。

**CRITICAL**: 明確なコンセプト方向性を選び、精密に実行する。大胆なマキシマリズムも洗練されたミニマリズムも有効です。鍵は意図性で、強度ではありません。

### フロントエンド美学ガイドライン

以下に注力する。

- **タイポグラフィ**: 美しく、ユニークで、興味深いフォントを選ぶ。Arial や Inter のようなジェネリックフォントを避け、フロントエンドの美学を高める独自の選択をする。予想外で個性的なフォント選択。特徴的なディスプレイフォントと洗練されたボディフォントをペアリングする。
- **カラーとテーマ**: 一貫した美学にコミットする。CSS 変数で一貫性を保つ。シャープなアクセントを持つドミナントカラーは、控えめで均等に分散されたパレットより効果を発揮する。
- **モーション**: エフェクトとマイクロインタラクションにアニメーションを使用する。HTML には CSS のみのソリューションを優先する。React では利用可能な場合 Motion ライブラリを使用する。インパクトのある瞬間に集中する。散在するマイクロインタラクションより、スタッガードリビール（animation-delay）を伴う単一の洗練されたページロードの方が喜ばれる。驚きを与えるスクロールトリガーとホバー状態を使用する。
- **空間構成**: 予想外のレイアウト。非対称性。オーバーラップ。対角線フロー。グリッドを破る要素。寛大なネガティブスペースまたは制御された密度。
- **背景とビジュアルディテール**: ソリッドカラーをデフォルトにせず、雰囲気と深みを作る。全体の美学に合ったコンテキスト的なエフェクトとテクスチャを追加する。グラデーションメッシュ、ノイズテクスチャ、ジオメトリックパターン、レイヤード透明度、ドラマチックシャドウ、デコラティブボーダー、カスタムカーソル、グレインオーバーレイなどのクリエイティブな形式を適用する。

### 禁止事項（ジェネリック AI 生成美学）

以下を絶対に使用しない。

- 使い古されたフォントファミリー（Inter、Roboto、Arial、システムフォント）
- クリシェなカラースキーム（特に白背景に紫グラデーション）
- 予測可能なレイアウトとコンポーネントパターン
- コンテキスト固有のキャラクターを欠く Cookie-cutter デザイン

### 実装原則

- クリエイティブに解釈し、コンテキストに合った予想外の選択をする
- 同じデザインを繰り返さない
- ライトテーマとダークテーマ、異なるフォント、異なる美学を使い分ける
- 世代間で一般的な選択（例: Space Grotesk）に収束しない
- 実装の複雑さを美的ビジョンに合わせる
  - マキシマリストデザインには広範なアニメーションとエフェクトを伴う精巧なコードが必要
  - ミニマリストまたは洗練されたデザインには抑制、精度、スペーシング・タイポグラフィ・微妙なディテールへの注意が必要
- エレガンスはビジョンを適切に実行することから生まれる
