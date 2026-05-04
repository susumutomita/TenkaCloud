# TenkaCloud 問題カタログ

TenkaCloud で配信する問題 (Battle / Challenge) は 1 ディレクトリ 1 問題の規約で管理する。
リポジトリの `problems/` 配下を見れば、現在カタログに載っている全問題が分かるのが正本。

## ディレクトリ構造

```
problems/
  <category>/                     # gameday / jam / ...
    <problem-id>/                 # kebab-case の問題 ID (= ディレクトリ名)
      metadata.json               # 問題メタデータ (UI / カタログ正本)
      template.yaml               # CFn ペライチ (deploy 本体)
      api/, frontend/, local/     # 任意の問題実装ファイル
      ...
  SCHEMA.json                     # metadata.json の JSON Schema (draft-07)
  README.md                       # このファイル
```

1 つの問題ディレクトリは **`metadata.json` と `template.yaml`** の 2 つだけあれば成立する。
追加の `api/` や `frontend/` 等は問題実装の都合で置く。

## 必須ファイル

### `metadata.json`

[`SCHEMA.json`](./SCHEMA.json) で形式を定義する。frontend のカタログ表示と backend の deploy
パイプラインの両方が参照する正本。記述例は
[`gameday/security-battle-royale/metadata.json`](./gameday/security-battle-royale/metadata.json)
を参照。

主なキーは次の通りです。

| キー                | 用途                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `id`                | kebab-case 英小文字 ID。ディレクトリ名と一致させる。CFn stack 名にも入る。 |
| `name`              | UI 表示名 (人間可読、日本語可)。                                          |
| `category`          | `Battle` (リアルタイム対戦) または `Challenge` (個別演習)。               |
| `status`            | `ready` / `draft` / `deprecated`。                                        |
| `difficulty`        | 1 (入門) 〜 5 (エキスパート)。                                            |
| `estimatedDuration` | 想定プレイ時間 (例: `60〜90 分`)。                                        |
| `shortDescription`  | カード表示用の 1 行サマリ。                                               |
| `description`       | 詳細ページの長文 (改行 OK)。                                              |
| `tags`              | 検索 / フィルタリング用 kebab-case タグ。                                 |
| `exposedPorts`      | deploy 後に参加者へ払い出されるポート (`{port, name}` の配列)。           |
| `learningGoals`     | 想定学習目的の箇条書き。                                                  |
| `cfnTemplate`       | 同ディレクトリ内 CFn テンプレートへの相対パス。                           |

### `template.yaml`

CloudFormation テンプレート。「ペライチ」とし、deploy 時には**このファイル単独**を競技アカウントの
CFn にアップロードして展開する。

#### 必須パラメータ

deploy パイプラインがすべての問題テンプレートに対して同じ引数で起動できるよう、
次のパラメータをサポートします。

| パラメータ        | 必須 | 用途                                                                            |
| ----------------- | ---- | ------------------------------------------------------------------------------- |
| `NamePrefix`      | ○    | `tc-{problemSlug}-{teamSlug}` 形式の共通リソース prefix。全リソース名に冠する。 |
| `AllowedCidr`     | -    | 公開ポートを許可する CIDR (default `0.0.0.0/0`)。                               |
| 問題固有パラメータ | -    | `DbPassword` 等。問題ごとに自由に追加してよい。                                 |

#### 命名規約 (衝突回避)

同一 (Account, Region) に複数チームの問題スタックが共存する運用を想定する。
すべてのリソース名 / タグ / グループ名等は `${NamePrefix}` を冠する。

例えば次のように記述します。

```yaml
Resources:
  MyVpc:
    Type: AWS::EC2::VPC
    Properties:
      Tags:
        - Key: Name
          Value: !Sub "${NamePrefix}-vpc"
```

#### 出力 (Outputs)

UI / 運営側で扱いやすいよう、最低でも次の Output を含めます。

- `FrontendUrl` / `ApiUrl` 等、参加者向けエンドポイント URL
- `InstanceId` 等、運営側のデバッグ用識別子
- `NamePrefix` (deploy 時の引数 echo)

## 新しい問題を追加する手順

1. `problems/<category>/<id>/` ディレクトリを作る (kebab-case)。
2. [`SCHEMA.json`](./SCHEMA.json) に従って `metadata.json` を書く。
3. `template.yaml` を書く (上記 NamePrefix 規約に沿う)。
4. docker-compose や言語ランタイム等を伴う問題では `api/` / `frontend/` / `local/` 配下に実装ファイルを置く。
5. `bun run validate:problems` (※今後追加) でメタデータの形式チェックを通す。
6. 動作確認: `aws cloudformation deploy --template-file template.yaml --stack-name tc-<id>-test --parameter-overrides NamePrefix=tc-<id>-test ...`

## frontend カタログとの連携 (今後)

現状 frontend (`apps/application-admin-console/src/data/problems.ts`) は問題カタログを静的リテラルで
持っている。今後 build 時に `problems/**/metadata.json` をスキャンして frontend に注入する仕組みを
入れ、`metadata.json` を正本とする (TODO)。

## ロードマップ (本 PR の範囲外)

以下は metadata.json 規約の上に積む後続の仕事。現状は枠組みだけ提示。

- **participant ポータル**: チームログインキーで認証し、自チームに deploy された問題への
  click-through 一覧 + 競技状況を見せる別アプリ。
- **scoreboard**: Battle / Challenge 両モード共通の得点 backend (DDB + 集計 Lambda)。
- **Challenge ダッシュボード**: 線グラフ + 得点ヒストリー + リアルタイム得点。
- **Battle 演出 / disruption イベント**: 競技中に妨害やシチュエーションチェンジを差し込む
  仕組み + ペナルティ / 得点の可視化。
- **deploy backend**: form 入力を受け取り、CFn テンプレートを competitor account の
  CloudFormation に展開する Lambda + cross-account AssumeRole + ステータス追跡。
