---
name: create-problem
description: TenkaCloud の問題ディレクトリ (problems/<category>/<id>/) を metadata.json + template.yaml の規約で生成する。Battle (リアルタイム対戦) または Challenge (個別演習) の雛形を作る。
allowed-tools: Bash(make validate-problems:*), Read, Write, Edit
---

# create-problem

TenkaCloud に新しい問題を追加するスキル。**正本は [`problems/README.md`](../../../problems/README.md) と [`problems/SCHEMA.json`](../../../problems/SCHEMA.json)**。1 ディレクトリ 1 問題、`metadata.json` と `template.yaml` の 2 ファイルがあれば成立する。

## ディレクトリ規約

```
problems/<category>/<id>/
├── metadata.json     # 必須: UI カタログと deploy パイプラインの正本
├── template.yaml     # 必須: CFn ペライチ (deploy 本体)
├── api/              # 任意: サーバーサイド実装 (Battle で API が要るとき)
├── frontend/         # 任意: 静的サイト (Battle で S3 frontend が要るとき)
└── local/            # 任意: docker-compose 等のローカル開発資材
```

`<category>` はディレクトリ命名上の分類（現状 `gameday/` を使っている）。`metadata.json` 内の `category` フィールドは **`Battle` か `Challenge`** の 2 値で、こちらが UI とパイプラインの正本。

## Step 1 — 要件ヒアリング

ユーザーから / 文脈から次を集める。不足はその場で訊く。

1. **category** — `Battle` (リアルタイム対戦) / `Challenge` (個別演習・常設チャレンジ)
2. **id** — kebab-case 英小文字 (例: `security-battle-royale`、`s3-secure-bucket`)。3〜32 文字。ディレクトリ名と一致させる
3. **name** — UI 表示名 (日本語可、80 文字以内)
4. **difficulty** — 1 (入門) 〜 5 (エキスパート)
5. **estimatedDuration** — 自由文字列 (例: `60〜90 分`)
6. **shortDescription** — カード用 1 行 (200 文字以内)
7. **description** — 詳細ページ用の長文 (改行 OK)
8. **tags** — kebab-case (例: `security`, `web`, `sql-injection`)
9. **exposedPorts** — deploy 後に参加者へ払い出すポート群 (`{port, name}` の配列)
10. **learningGoals** — 想定学習目的の箇条書き
11. **AWS リソース概要** — `template.yaml` で何を立てるか (EC2 / RDS / S3 / Lambda 等)
12. **status** — 通常は `draft` で作成、レビュー後 `ready`

## Step 2 — `metadata.json` を書く

`problems/SCHEMA.json` に従う。スキーマ補完のため `$schema` を相対パスで先頭に置く。

```json
{
  "$schema": "../../SCHEMA.json",
  "id": "<id>",
  "name": "<name>",
  "category": "Battle",
  "status": "draft",
  "difficulty": 3,
  "estimatedDuration": "60〜90 分",
  "shortDescription": "<カード用 1 行>",
  "description": "<長文。改行可>",
  "tags": ["security", "web"],
  "exposedPorts": [
    { "port": 80, "name": "frontend (nginx)" },
    { "port": 8080, "name": "api (Flask)" }
  ],
  "learningGoals": [
    "<目的 1>",
    "<目的 2>"
  ],
  "cfnTemplate": "template.yaml"
}
```

## Step 3 — `template.yaml` を書く

CloudFormation **ペライチ**。deploy パイプラインがこのファイル単独を競技者アカウントの CFn にアップロードする。次の規約を守る。

### 必須パラメータ

deploy パイプラインがすべての問題テンプレートに対して同じ引数で起動できるよう、共通パラメータをサポートする。

| パラメータ           | 必須 | 用途                                                                       |
| -------------------- | ---- | -------------------------------------------------------------------------- |
| `NamePrefix`         | ○    | `tc-{problemSlug}-{teamSlug}` 形式の共通リソース prefix                    |
| `AllowedCidr`        | -    | 公開ポートを許可する CIDR (default `0.0.0.0/0`)                            |
| 問題固有パラメータ   | -    | `DbPassword` など、問題ごとに自由に追加してよい                            |

### 命名規約 (衝突回避)

同一 (Account, Region) に複数チームの問題スタックが共存する。**全リソース名 / タグ / グループ名は `${NamePrefix}` を冠する**。

```yaml
Parameters:
  NamePrefix:
    Type: String
    Description: "tc-<problem>-<team> 形式の共通 prefix"
  AllowedCidr:
    Type: String
    Default: "0.0.0.0/0"

Resources:
  MyVpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
      Tags:
        - Key: Name
          Value: !Sub "${NamePrefix}-vpc"
```

### 必須 Outputs

UI / 運営側で扱いやすいよう、最低でも次の Output を含める。

- 参加者向けエンドポイント URL (`FrontendUrl` / `ApiUrl` 等)
- 運営側のデバッグ用識別子 (`InstanceId` 等)
- `NamePrefix` (deploy 時の引数 echo)

```yaml
Outputs:
  NamePrefix:
    Description: "Deploy 時に渡された prefix (echo)"
    Value: !Ref NamePrefix
  FrontendUrl:
    Description: "参加者向け frontend URL"
    Value: !Sub "http://${MyEip}/"
```

## Step 4 — 任意の補助ディレクトリ

問題実装の都合で次を置いてよい。**規約ではなく自由領域** なので、必要なものだけ作る。

- `api/` — サーバーサイドコード (Flask / Express 等)
- `frontend/` — 静的サイト
- `local/` — docker-compose や開発用スクリプト

## Step 5 — 検証

`make validate-problems` で `problems/SCHEMA.json` に対して `metadata.json` を検証する。CI でも走るので、ここで通らないと PR がブロックされる。

```bash
make validate-problems
```

実 deploy の動作確認は競技者アカウントで:

```bash
aws cloudformation deploy \
  --template-file problems/<category>/<id>/template.yaml \
  --stack-name tc-<id>-test \
  --parameter-overrides NamePrefix=tc-<id>-test \
  --capabilities CAPABILITY_NAMED_IAM
```

## チェックリスト

雛形作成後、次を確認する。

- [ ] `metadata.json` の `id` がディレクトリ名と完全一致
- [ ] `category` が `Battle` か `Challenge` (大文字始まり)
- [ ] `cfnTemplate` で参照する `template.yaml` が同ディレクトリにある
- [ ] `template.yaml` の Parameters に `NamePrefix` を含む
- [ ] 全リソース名・タグに `${NamePrefix}` が冠されている
- [ ] Outputs に参加者向け URL と `NamePrefix` echo がある
- [ ] `make validate-problems` が通る
- [ ] `status` は `draft` で作成（ready は別 PR でレビュー後に上げる）

## 参考

- 実例: [`problems/battles/security-battle-royale/`](../../../problems/battles/security-battle-royale/) — Battle 問題の参考実装
- スキーマ: [`problems/SCHEMA.json`](../../../problems/SCHEMA.json)
- 規約正本: [`problems/README.md`](../../../problems/README.md)
- 競技者アカウント側のセットアップ: [`infrastructure/templates/README.md`](../../../infrastructure/templates/README.md)
