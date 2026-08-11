---
name: blindspot-pass
description: 実装計画・Issue・PR diff・特定ディレクトリを対象に、計画に書かれていない前提／未接続の境界／将来の運用条件など「計画を無効化しうる未知 (unknown unknowns)」をコード・設定・テストの証拠で洗い出し、意思決定可能な形で報告する review-only スキル。実装開始前・PR 前・設計レビュー時に使う。設計は変更しない。
---

# Blindspot pass — 未知の未知を探す

実装計画や Issue は既知の要件を整理するには強いが、**計画に書かれていない前提・未接続の境界・将来の運用条件**までは保証しない。個々のスライスがテスト green でも、producer/consumer が互いに接続されていない、同じ操作でも経路ごとに account 解決の前提が違う、データ面が分断されている、といった「計画を破綻させうる未知」は後から見つかる。

このスキルは、そうした未検証の前提を**証拠付きで探し、report として出す**ためのもの。参考: [A Field Guide to Fable: Finding Your Unknowns](https://www.anthropic.com/engineering)。

## これは何をするスキルか / しないスキルか

- **する**: 対象を検証可能な仮説へ分解し、blindspot matrix で横断確認し、コード・設定・テスト・生成物 (synth 等) で裏取りし、重要度付きで報告する。
- **しない**: 設計や仕様を勝手に書き換えない。リファクタや Issue 起票を自律実行しない。`/security-review` / `/simplify` / 通常テストゲートを置換しない。**review-only** で、コード変更は一切行わない。

## 入力（対象の指定方法）

対象は次のいずれか（複数可）を受け取れる。

- **Issue**: `#<番号>` — `gh issue view <n>` で本文・完了条件を読む
- **設計メモ**: 対象となる文書や実装のパス
- **PR diff**: `#<PR番号>` または `git diff <base>...<head>`（未完成ブランチも可）
- **ディレクトリ / パス**: `infrastructure/lib/intent-ingress/` のような範囲

対象が曖昧なときは推測で補完せず、後述の「未確定」として残す。

## 実行フロー

### 1. 対象と成功条件を固定する

入力から短く抽出する。情報不足は推測で埋めず `未確定` と記す。

- 何を変える計画か
- 何が完了条件か
- どの境界をまたぐか（UI / Worker / API / queue / Lambda / DB / AWS account / identity など）
- 既知の不変条件・fail-closed 条件・ロールバック条件

### 2. 計画の主張を「検証可能な仮説」に分解する

各主張を、確認すべき producer / consumer / transport / identity / storage / cleanup / observability に紐付ける。例:

- 「Worker が deploy intent を発行すれば ingress が正しい競技者アカウントへ deploy する」
- 「destroy を実行すればイベント単位の runtime を安全に掃除できる」
- 「D1 の event/team が deploy pipeline と採点系から参照できる」

### 3. blindspot matrix で横断確認する（必須観点）

| 観点 | 探すもの |
| --- | --- |
| Producer / consumer | producer のない consumer、consumer のない producer、片側だけの schema / event / env var |
| 経路差分 | API・Worker・Lambda・CLI・workflow など、同じ操作の別経路で異なる既定値・認可・account 解決 |
| Identity / tenancy | tenant / event / actor / role / audience の生成元・伝搬・検証・欠落時の挙動 |
| Data seam | DB / projection / cache / queue 間で writer がない・読まれない・schema が別・同期契約がない箇所 |
| Lifecycle | create / deploy / update / destroy / retry / rollback / sweeper が同じ resource identity を参照するか |
| Failure mode | 4xx / 5xx / timeout / retry / partial failure / idempotency / default が fail-open になっていないか |
| Security | secret 配置・署名方式・鍵ローテーション・scope・最小権限・cross-account 境界 |
| Operations | tag・監査ログ・メトリクス・alert・コスト backstop・手動復旧手順 |
| Spec drift | doc / コメント / 型の記述と実装（既定値・分岐）が食い違っていないか |
| Test illusion | 単体テストは green だが実経路・別プロセス・別アカウント・実データ面を通っていない箇所 |

**メタパターン**: 並行スライスを個別に作ると「producer のない consumer / consumer のない producer」が量産される。各片が green のテストを持つため完成に見える — ここを最優先で疑う。

### 4. コードで裏取りする

発見は推測だけで確定しない。可能な限り以下を添える。

- 該当ファイル・シンボル・行番号
- producer / consumer のどちらが欠けるか
- 実際に選ばれる default 値または failure path
- 関連するテストの範囲と、なぜ見逃すか
- 最小の再現手順、または grep / test / synth での確認方法

規模が大きければ Explore / general-purpose サブエージェントに観点を割り当てて並行探索し、結論だけ集約してよい。

### 5. 重要度を判定して報告する

- **Critical**: 誤アカウント・誤テナント・データ露出・恒久的コスト・破壊的操作など、計画の安全性を崩す
- **High**: 本番で主要フローが止まる、または復旧が困難
- **Medium**: 将来の統合時に高確率で不整合になる
- **Low**: dead code、doc drift、未使用 abstraction

`Critical / High` は「次の実装前に解くべき blocker か」を明記する。

## 出力フォーマット

```md
# Blindspot pass: <対象>

## 結論
- 計画を進めてよい / 条件付きで進めてよい / blocker を先に解くべき
- 最重要の未知: <1行>

## 対象と前提
- 対象:
- 成功条件:
- 未確定な前提:

## 発見
### [Critical|High|Medium|Low] <短いタイトル>
- **何が起きるか**:
- **なぜ見落としやすいか**:
- **証拠**: `path:line` / symbol / command output
- **影響範囲**:
- **最小の是正方向**:
- **blocker 判定**: yes / no

## 接続マップ
- producer -> transport -> consumer
- identity / tenancy propagation
- lifecycle ownership

## 未検証のまま残る事項
- <調査不能だったものと理由>

## 次のアクション
1. <最優先>
2. <次点>
```

## 安全ガード

- 仕様を勝手に書き換えない。
- 「存在しない」と断言する前に、repo 全体検索・関連設定・生成物・テストを確認する（`grep` empty だけを根拠にしない）。
- 証拠を得られない発見は `仮説` と明示し、Critical と断定しない。
- 発見数を競わない。計画を無効化しうるものを優先する。
- 実装中の未完成ブランチでは「`main` にないこと」と「設計上不要なこと」を区別する。

## 完了後

report のみを出す。修正を勝手に実装しない。ユーザーが是正を指示したら、Critical から着手する。
