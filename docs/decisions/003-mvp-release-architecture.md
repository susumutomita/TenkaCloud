# ADR-003: MVP リリースに向けた全体アーキテクチャ設計

- **Status**: Accepted
- **Date**: 2026-04-04
- **Deciders**: susumutomita

## Context

現在の TenkaCloud は各サービスが独立して存在するが、エンドツーエンドのフローが繋がっていない。イベントを作成してから参加者がプレイし、結果を確認するまでの一連の流れが破綻している。

### 現状の致命的ギャップ

1. イベント作成の管理 UI が存在しない（バックエンド API はある）
2. イベント（problem-service）と GameDay（gameday-service）が連携しない
3. 参加登録からチーム編成、ゲーム開始までのフローが断絶
4. JAM の問題エディタがなく、問題を作成できない
5. スコアリングスキーマが GameDay と JAM で分離しており統一されていない
6. Leaderboard が GameDay のスコアを集計しない

## Decision

### MVP スコープ定義

MVP では以下の 2 つのイベントタイプをサポートする。

- **GameDay**: チーム対抗の攻防戦（攻撃購入→実行→防御→スコア競争）
- **JAM**: 個人/チームでの問題解決コンテスト

### エンドツーエンドフロー

```text
[管理者フロー]
1. イベント作成（名前・タイプ・日時・チーム設定）
2. GameDay → 攻撃カタログ設定
   JAM → 問題追加・配点設定
3. イベント公開（draft → scheduled）
4. 参加者の登録を確認
5. ゲーム開始（scheduled → active）
6. リアルタイム監視（スコアボード・攻撃ログ）
7. ゲーム終了（active → completed）
8. 結果確認・表彰

[参加者フロー]
1. イベント一覧からイベントを選択
2. 参加登録（チーム作成 or チーム参加 or ソロ）
3. GameDay → 司令部で攻撃購入・実行・防御
   JAM → 問題一覧から問題を解く
4. スコアボードで順位確認
```

### サービス間連携設計

```text
problem-service（イベント管理・問題管理）
  ↓ イベント作成時に eventId を発行
  ↓ type=gameday の場合
gameday-service（ゲーム状態管理）
  ↓ GameState を初期化（攻撃カタログ自動シード）
  ↓ チーム登録を受付
  ↓ スコア変動を通知
leaderboard-service（スコア集計・配信）
  ← gameday-service/problem-service からスコアを受信
  → SSE でリアルタイム配信
```

### 統一スコアリングスキーマ

```typescript
interface ScoreEvent {
  eventId: string;
  teamId: string;
  userId: string;
  category: 'attack_success' | 'attack_blocked' | 'defense_fix' | 'hint_purchase' | 'attack_purchase' | 'challenge_solve' | 'clue_reveal';
  points: number;       // 正の値 = 獲得、負の値 = 消費
  metadata: Record<string, unknown>;
  timestamp: string;
}
```

**GameDay のポイント経済:**

| アクション | ポイント | 説明 |
|-----------|---------|------|
| 初期ポイント | +10,000 | ゲーム開始時に全チームに付与 |
| 攻撃購入 | -3,000 | 攻撃カタログから購入 |
| 攻撃成功 | +1,000 | 相手チームの脆弱性を突く |
| 攻撃被弾 | -1,000 | 脆弱性を突かれる |
| 防御成功（修正） | +1,500 | 脆弱性を修正して攻撃を無効化 |
| ヒント購入 | -500〜-3,000 | 防御ヒントを購入 |
| ヘルスチェック合格 | +200/回 | 定期ヘルスチェックに合格 |

**JAM のポイント経済:**

| アクション | ポイント | 説明 |
|-----------|---------|------|
| 問題正解 | +100〜+1,000 | 難易度に応じた配点 |
| ヒント使用 | -20% | 正解ポイントから 20％ 減額 |
| 早解きボーナス | +10% | 最初の N チームにボーナス |

### イベントライフサイクル

```text
draft → scheduled → active → completed → cancelled
  ↓        ↓          ↓ ↑        ↓
 編集可   参加受付   プレイ中   結果確認
                      ↓ ↑
                     paused
```

実装: `problem-service/src/services/event-lifecycle.ts`

### UI ページ実装状態

**管理者側:**
- `/admin/events/new` — イベント作成フォーム（実装済み）
- `/admin/events/[id]/edit` — イベント編集（実装済み）
- `/admin/events/[id]/problems` — 問題管理+デプロイ（実装済み）
- `/admin/events/[id]/attacks` — 攻撃カタログ管理（実装済み）
- `/admin/gameday/[id]` — ゲーム制御パネル（実装済み）
- `/admin/gameday/[id]/dashboard` — リアルタイムダッシュボード（実装中）
- `/admin/gameday/[id]/report` — ポストゲームレポート（実装中）

**参加者側:**
- `/events` — イベント一覧（実装済み）
- `/events/[id]` — イベント詳細+参加登録（実装済み）
- `/gameday/[id]` — 司令部（実装済み）
- `/gameday/[id]/attack` — 攻撃ステーション（実装済み）
- `/gameday/[id]/defense` — 防御トレンチ（実装済み）
- `/gameday/[id]/alliance` — 同盟（実装済み）
- `/gameday/[id]/vote` — 投票（実装済み）
- `/gameday/[id]/scoreboard` — スコアボード（実装済み、SSE）
- `/gameday/[id]/tutorial` — チュートリアル（実装中）

## Consequences

- **Good**: エンドツーエンドのフローが繋がり、実際にイベントを開催・参加できるようになる
- **Bad**: problem-service と gameday-service の連携実装が必要で、既存コードの改修が発生する
- **Tradeoff**: MVP ではイベント間連携（トーナメント等）を見送り、単一イベント完結で出す

## References

- ADR-002: Security Battle Royale シナリオ仕様
