---
name: create-verify-challenge
description: 参加者が自分でアプリを外部 (Cloudflare Workers / コンテナ / 任意クラウド) にデプロイし、その URL を問題側の検証 API に渡して採点する「self-deploy + verify」型のチャレンジ問題を作る。問題が検証 Lambda を deploy し、platform は flag (鍵) を検証するだけ。Issue #1973 の作り方を再現する。
allowed-tools: Bash(bun run scripts/tenkacloud-problem.ts:*), Bash(make validate-problems:*), Bash(cd problems:*), Read, Write, Edit, Glob
---

# create-verify-challenge — self-deploy + verify 型チャレンジ

参加者が **自分のアプリを外部に公開して URL を出し**、問題側の **検証 API がその URL を採点する** 型の問題を作る skill。AWS リソースを participant に作らせず、「URL を 1 本出すだけ」で成功体験を作りたいときに使う (Issue #1973)。

**正本**: [`problems/SCHEMA.json`](../../../problems/SCHEMA.json) (`scoring.kind:"flag"`) と [`docs/problems/AUTHORING.html`](../../../docs/problems/AUTHORING.html)。
**正典の実例 (必ず読む)**: `problems/challenges/x402-paywall/`。これは「問題が gate Lambda を deploy → 参加者が叩く → 合格で flag → platform が flag 検証」の完成例。本 skill はこれを「**外部 URL を verify する**」形に一般化したもの。

## 設計の鉄則 (ここを外すと作り直しになる)

1. **問題は plugin、platform は host** (ADR-012)。問題コードは **TenkaCloudChallenge** リポジトリ (本リポジトリでは `problems/` submodule として配置済み。作業はその `problems/` ディレクトリ内で行う) に置く。**main リポジトリ (platform) には問題も採点条件も置かない**。
2. **評価関数は「問題側」で動く**。問題の `template.yaml` が **検証 Lambda** を deploy し、それが参加者の URL を叩いて採点する。platform の Lambda には一切評価ロジックを足さない (= 新しい platform コードを書かない。`scoring.kind:"flag"` を再利用するだけ)。
3. **platform は鍵を持つだけ**。検証 Lambda は per-deploy のランダム flag を持ち、合格時だけ返す。flag は CFn Output (`AnswerFlag`) に出し、platform の flag 採点が submit と突き合わせる。参加者に `cloudformation:DescribeStacks` は渡さない (= Output から flag を読ませない)。
4. **answer 系を repo に置かない** (ADR-008)。隠しテスト・期待値・flag は検証 Lambda の中 (= deploy 先) にだけ存在する。README/参加者向け資産には採点条件を書かない。
5. **ローカルは Docker + Kumo** ([`sivchari/kumo`](https://github.com/sivchari/kumo) = ローカル AWS エミュレータ)。実 AWS と切り離して `template.yaml` をローカル検証する (`problems/` 側の `bun run validate:kumo`)。

## 3 アセット (1 dir = 1 問題)

```
problems/challenges/<id>/
├── metadata.json   # scoring.kind="flag" + flagOutputKey="AnswerFlag" + hints (SCHEMA 準拠)
├── template.yaml   # 検証 Lambda (Function URL) を deploy。参加者 URL を verify し合格で flag を返す
└── README.md / README.ja.md  # 参加者向け契約 (採点条件は書かない)
```

### metadata.json (flag 採点を再利用)

```jsonc
"scoring": {
  "kind": "flag",
  "flagOutputKey": "AnswerFlag",
  "points": 300,
  "wrongAnswerPenalty": 15,
  "hints": [ /* 段階ヒント */ ]
}
```

`cfnParameters: { "FlagSeed": "__RANDOM_PASSWORD__" }` で per-deploy ランダム flag を注入する (x402-paywall と同じ)。

### template.yaml (検証 Lambda = 評価関数の実体)

x402-paywall の `GateFunction` を雛形にする。要点:

- `AWS::Lambda::Function` + `FunctionUrl` (AuthType=NONE) で `GET /verify?url=<participant-app-url>` を公開。
- `Environment.FLAG = !Sub "TC{${FlagSeed}}"`。
- handler の中で **参加者 URL を guard 付き fetch** して隠しテストを実行。
  - SSRF 対策: スキーム/ホスト許可リスト・リダイレクト非追従・タイムアウト・本文サイズ上限を Lambda 内で実装 (外部 URL を無検証で叩かない)。
- 全テスト合格時のみ `FLAG` を返す。1 つでも落ちたら採点ロジックを漏らさない安全なメッセージだけ返す。
- `Outputs.AnswerFlag: !Sub "TC{${FlagSeed}}"` (採点エンジン専用、参加者は読めない)。

参加者フロー: 自分のアプリを Cloudflare 等にデプロイ → `curl 'https://<verify-fn-url>/verify?url=https://<自分のapp>.workers.dev'` → 返ってきた `TC{...}` を Portal に submit。

## 手順

1. `problems/` submodule 内で作業ブランチを切る ([submodule workflow](../../../AGENTS.md))。
2. `bun run scripts/tenkacloud-problem.ts create <id> --kind flag` で雛形生成。
3. `template.yaml` に検証 Lambda + Function URL + `AnswerFlag` Output を追記 (x402-paywall を参照)。`FlagSeed` パラメータを追加。
4. README に参加者向け契約 (公開すべき API 仕様・デプロイ方法) を書く。**採点条件は書かない**。
5. ローカル検証: `bun run validate` (schema) → `bun run kumo:up && bun run validate:kumo` (Kumo で template 検証) → `bun run kumo:down`。
6. `bun run scripts/tenkacloud-problem.ts validate <id>` で最終確認。
7. PR は `problems/` repo へ。main 側は submodule pin bump のみ (= platform コードは変更しない)。

## やってはいけない (過去の失敗)

- platform (`packages/*`, `infrastructure/lib/*`) に評価エンジンや challenge 定義を作る → 設計違反。評価は問題側、platform は flag 検証のみ。
- main リポジトリに参加者資産や隠しテストを置く (`sample-challenges/` を main に作る等) → ADR-008 違反。問題は TenkaCloudChallenge へ。
- bespoke なローカルサーバを別途作る → ローカルは既存の Docker + Kumo 経路を使う。
- 検証 Lambda で参加者 URL を無検証 fetch する → SSRF。許可リスト・タイムアウト・サイズ上限を必ず入れる。
