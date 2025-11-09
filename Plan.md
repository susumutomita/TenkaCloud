# TenkaCloud Development Plan

このファイルは、TenkaCloud の開発プロセス、意思決定、実装内容、振り返りを記録するためのドキュメントです。

## 実行計画 (Exec Plans)

### マルチテナントSaaSアーキテクチャ基盤構築 - 2025-01-08

**目的 (Objective)**:
- AWS SaaS Factory EKS Reference Architecture をベースにしたマルチテナント基盤の設計
- Control Plane / Application Plane の 2 層アーキテクチャ実装
- 3 層 UI 構造（Control Plane UI / Admin UI / Participant UI）の設計

**制約 (Guardrails)**:
- テナント間のデータ分離を厳格に実施
- すべての実装はテストファースト（カバレッジ 100％）
- ユビキタス言語を使用した命名規則の徹底

**タスク (TODOs)**:
- [x] AWS SaaS Factory EKS Reference Architecture の調査
- [x] マルチテナントアーキテクチャ設計書作成
- [x] バックエンドディレクトリ構造作成
- [x] インフラストラクチャディレクトリ構造作成
- [x] アーキテクチャドキュメント作成（multi-tenant-design.md、directory-structure.md）
- [x] CLAUDE.md に開発プレイブック追加
- [x] Plan.md 初期化
- [x] GitHub Issue テンプレート作成
- [ ] バックログを GitHub Issue に書き起こし

**検証手順 (Validation)**:
- ドキュメントの網羅性確認
- ディレクトリ構造の妥当性確認
- アーキテクチャ設計のレビュー

**未解決の質問 (Open Questions)**:
- LocalStack vs kind（ローカル開発環境）
- テストフレームワークの選択（Jest vs Vitest）

**進捗ログ (Progress Log)**:
- [2025-01-08 14:00]AWS SaaS Factory EKS Reference Architecture 調査完了
- [2025-01-08 15:30]Control Plane/Application Plane 設計完了
- [2025-01-08 16:00]3 層 UI 構造設計追加（Control Plane UI/Admin UI/Participant UI）
- [2025-01-08 16:30]Deployment Management Service 設計追加
- [2025-01-08 17:00]ディレクトリ構造作成完了
- [2025-01-08 17:30]アーキテクチャドキュメント作成完了
- [2025-01-08 18:00]CLAUDE.md に開発プレイブック追加
- [2025-01-08 18:15]Plan.md 初期化
- [2025-01-08 18:20]GitHub Issue テンプレート作成完了

**振り返り (Retrospective)**:

##### 問題 (Problem)
PR を作成した後、CI の状態確認を忘れて push がタイムアウトした。

##### 根本原因 (Root Cause)
- PR ワークフローに「CI の状態確認」が明示的に含まれていなかった
- タイムアウト時の対応手順が不明確だった

##### 予防策 (Prevention)
- CLAUDE.md の「自律開発フロー」に「CI 検証」ステップを追加（CRITICAL）
- CI ステータス確認コマンドを明示（`gh pr checks`）
- 失敗時の修正フローを文書化

→ 対応完了

---

## 次の実行計画テンプレート

以下のテンプレートを使用して、新しい機能開発の実行計画を作成してください：

```markdown
### [機能名] - [YYYY-MM-DD]

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
（問題が発生した場合のみ記入）

##### 問題 (Problem)
何が起きたか（具体的に）

##### 根本原因 (Root Cause)
なぜ起きたか（技術的・プロセス的）

##### 予防策 (Prevention)
- CLAUDE.md に追加すべきルール
- 自動化できるチェック
- ドキュメント更新
```
