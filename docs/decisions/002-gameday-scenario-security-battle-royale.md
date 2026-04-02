# ADR-002: GameDay シナリオ — Security Battle Royale の再現

- **Status**: Accepted
- **Date**: 2026-04-02
- **Deciders**: susumutomita

## Context

JAWS Days 2026 で開催された AWS GameDay「Security Battle Royale」に参加。TenkaCloud の GameDay 機能はこのイベントの再現を目標とする。

## 元イベントの構造

### イベント概要

- **イベント名**: Security Battle Royale AWS GameDay — JAWS Days 2026
- **形式**: チーム対抗（15 チーム規模）、リアルタイムスコアリング
- **制限時間**: 数時間
- **プラットフォーム**: AWS GameDay（Cloudscape Design System ベースの UI）

### UI 構成（AWS GameDay 本家）

**サイドバーナビゲーション:**
- Event: Home, Score events, Scoreboard, Notifications, AWS Console, Survey
- Quests: Security Battle Royale, Generative AI Insights, AI-Powered Cloud Security with SentinelOne
- Tools: Best Team Name, Cloud IDE, SSO Credentials

**ヘッダー:** Score 表示、Rank 表示、チーム名、言語切替。

### 攻撃カタログ（実際のイベントで使用）

スクリーンショットから確認できた攻撃は以下のとおり。

| Attack Name | Type | 説明 |
|------------|------|------|
| BACKDOOR | vulnerability | バックドアルート悪用 |
| COMPROMISED WebSITE | vulnerability | Web サイト改竄 |
| DATA EXFILTRATION | vulnerability | データ窃取 |
| EC2 SYSTEM STATUS CHECK FAILED | chaos | EC2 インスタンス障害 |
| HACKED BUCKET | vulnerability | S3 バケット不正アクセス |
| MHCS | chaos | ヘルスチェック障害 |
| LEAKED CREDENTIALS | vulnerability | 認証情報漏洩 |
| PASSWORD ROTATION | vulnerability | パスワードローテーション |
| SQL INJECTION | vulnerability | SQL インジェクション |

### ヘルスチェック項目

各チームの Application Status として 4 項目を監視する。

| Check | 説明 |
|-------|------|
| APIs | API エンドポイントの応答 |
| DB Reads | データベース読み取り |
| DB Writes | データベース書き込み |
| Website | Web サイトの稼働状態 |

### スコアボード

- ランキング表示（順位、チーム名、トレンド、スコア）
- 1 位: 195,500 点、最下位: 78,025 点（15 チーム中）
- トレンド列でスコアの変動を追跡
- リアルタイム更新

### 攻撃統計ダッシュボード

- チーム名 × 攻撃名のマトリックス
- 各セル: Launched（発射回数）、Next Available（クールダウン）、Received（被弾回数）、Vulnerable?（脆弱性あり/なし/不明）
- フィルタ: チーム名、攻撃名、脆弱性ステータス

## Decision

TenkaCloud の GameDay 機能は上記の Security Battle Royale を忠実に再現する。

### 再現する要素

1. **攻撃カタログ**: 上記 9 攻撃を `default-attacks.ts` に実装（一部実装済み）
2. **ヘルスチェック**: APIs / DB Reads / DB Writes / Website の 4 項目監視
3. **スコアボード**: ランキング + トレンド + リアルタイム更新
4. **攻撃統計**: チーム × 攻撃のマトリックスビュー
5. **Application Status**: チーム一覧 + 4 項目の稼働状態
6. **Attack History**: 全攻撃ログの時系列表示
7. **Quest 構造**: 複数の Quest（Security Battle Royale 等）を同時開催可能に

### 再現しない要素（AWS 固有）

- AWS Console 直接リンク（AWS アカウントが必要）
- SSO Credentials 配布（AWS IAM Identity Center 依存）
- Cloud IDE（AWS CloudShell / Cloud9 依存）
- SentinelOne 連携（サードパーティ依存）

### 追加する差別化要素（TenkaCloud 独自）

- 同盟システム（Alliance）
- 投票システム（Voting）
- 防御ヒント購入
- 脆弱性修正レポート

## Consequences

- **Good**: 実際のイベント体験をベースにした設計で、参加者にとって馴染みのある UX を提供
- **Bad**: AWS GameDay の一部機能（AWS Console 連携等）は LocalStack/Kumo で完全再現不可
- **Tradeoff**: AWS 固有機能を除外する代わりに、同盟・投票など独自のソーシャル機能で差別化

## References

- JAWS Days 2026 AWS GameDay 参加体験
- AWS GameDay Scoreboard (Security Battle Royale)
