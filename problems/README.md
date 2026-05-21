# TenkaCloud 問題カタログ

> English version: [README.en.md](./README.en.md)

TenkaCloud で配信する問題 (**Battle** / **Challenge**) は 1 ディレクトリ 1 問題の規約で管理する。 `problems/` 配下を見れば、 現在カタログに載っている全問題が分かるのが正本。

問題は ADR-012 の **plugin architecture** で扱う: 1 問題は `metadata.json` + `template.yaml` + 任意の `portal/` slot + 任意の `services/` 実装の 3 〜 4 アセットで完結する。 platform 側 (= `infrastructure/lib/problem-deploy/`) は generic dispatcher として metadata だけを見て scoring / portal / disruption を捌く。 問題固有のコードは問題ディレクトリの中に閉じる。

実装済み問題と次に作る候補を横断して眺めたい場合は [`docs/gallery.md`](../docs/gallery.md)、 30 分でゼロから 1 問書く手順は [`docs/problems/AUTHORING.html`](../docs/problems/AUTHORING.html) を参照。

## ディレクトリ構造

```
problems/
├── battles/                       # Battle (リアルタイム対戦)
│   ├── hello-world-battle/
│   ├── microservice-migration-battle/
│   ├── security-battle-royale/
│   └── stackstack/
├── challenges/                    # Challenge (個別演習)
│   └── hello-world/
├── SCHEMA.json                    # metadata.json の JSON Schema (draft-07、正本)
├── index.json                     # 全 metadata から build した catalog 一覧 (= make build-problems-index で生成)
└── README.md                      # このファイル
```

1 つの問題ディレクトリは次の 4 アセットで構成する (ADR-012)。

| アセット                | 必須 | 用途                                                                          |
| ----------------------- | ---- | ----------------------------------------------------------------------------- |
| `metadata.json`         | ○    | UI カタログ表示 + scoring engine + portal plugin の正本。                       |
| `README.md` / `README.en.md` | ○    | 問題詳細 (ストーリー / 解き方 / 学習目的)。 i18n は ja + en の 2 言語。       |
| `template.yaml`         | ○    | CFn ペライチ (deploy 本体)。 競技アカウントに `aws cloudformation create-stack` で展開される。 |
| `portal/<slot>.tsx`     | -    | 問題固有の participant portal UI (`dashboard.slots` から参照)。               |
| `services/`             | -    | 問題固有の実装 (docker-compose / Lambda code 等。 EC2 UserData から fetch)。  |

## カテゴリ

| カテゴリ    | 性質                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| `Battle`    | リアルタイム対戦。 1 イベントで複数チームが同時 deploy、 uptime / 防御 / phase 進行で得点。 |
| `Challenge` | 個別演習。 evergreen で常時開かれている、 1 deploy = 1 flag 提出が典型。   |

両者は分離せず、 metadata `category` で識別する。 Battle 内に CTF 風の sub-quest を持たせる構成も可。

## metadata.json

JSON Schema は [`SCHEMA.json`](./SCHEMA.json) が正本。 frontend カタログと backend deploy パイプラインの両方が参照する。

### 必須キー

| キー                | 用途                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `id`                | kebab-case 英小文字 ID。 ディレクトリ名と一致させる。 CFn stack 名 prefix にも入る。              |
| `name`              | UI 表示名 (人間可読、 日本語 OK)。                                                                |
| `category`          | `Battle` または `Challenge`。                                                                     |
| `status`            | `ready` / `draft` / `deprecated`。                                                                |
| `visibility`        | `public` / `private`。 private は admin console のみで見える。                                    |
| `difficulty`        | 1 (入門) 〜 5 (エキスパート)。                                                                    |
| `estimatedDuration` | 想定プレイ時間 (例: `60〜90 分`)。                                                                |
| `shortDescription`  | カード表示用の 1 行サマリ。                                                                       |
| `description`       | 詳細ページの長文 (改行 OK)。                                                                      |
| `tags`              | 検索 / フィルタ用 kebab-case タグ。                                                               |
| `exposedPorts`      | deploy 後に参加者へ払い出されるポート (`{port, name}` の配列)。 公開エンドポイント無しなら 1 要素 placeholder。 |
| `learningGoals`     | 想定学習目的の箇条書き。                                                                          |
| `cfnTemplate`       | 同ディレクトリ内 CFn テンプレートへの相対パス (通常 `template.yaml`)。                            |

### 任意キー (ADR-012 thick metadata DSL)

| キー             | 用途                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `i18n.en`        | 英語訳 (`name` / `shortDescription` / `description` / `learningGoals`)。 ja は top-level、 en はここに。 サポート locale は **ja + en のみ** (#1108)。 |
| `scoring`        | 5 種 builtin kind から 1 つを宣言 (= 後述)。 省略すると scoring 無効 (= deploy のみ)。               |
| `endpoints`      | uptime / phased-polling 系で probe する endpoint の宣言 (`slot` / `outputKey` / `path`)。            |
| `phases`         | `phased-polling` 用。 時間経過で score rule や endpoint binding が切り替わる段階を `afterMinutes` 昇順で宣言。 |
| `disruptions`    | Battle 中に発火する妨害イベント (`after-deploy` / `team-score-above` / `phase-entered` トリガー)。 |
| `dashboard.slots`| participant portal に差し込む問題固有 React component (`portal/<slot>.tsx`) のスロット定義。       |
| `cfnParameters`  | deploy 時に operator が入力する CFn パラメータの hint。                                              |

### scoring kinds

1 問題につき 1 kind。 platform 側の generic dispatcher (ADR-012 Phase 3) が読み分ける。

| kind                | 概要                                                                                                   | 例                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `flag`              | Challenge 型。 1 deploy 1 回提出、 `flagOutputKey` (CFn Output) と submitted flag を一致比較。         | `hello-world`                     |
| `uptime-flat`       | 1 〜 N endpoint を独立に probe。 成功した endpoint 分だけ加点 (= 部分稼働でも稼ぐ)。                   | `hello-world-battle`              |
| `uptime-multi`      | N endpoint を probe、 全 OK の時だけ `pointsAllOk`。 1 つでも fail なら 0 点 + `failurePenalty`。      | `security-battle-royale`          |
| `phased-polling`    | 時間経過で score rule が切り替わる polling 型。 `phases[]` と組み合わせて段階的劣化 / hosting 切替を表現。 | `microservice-migration-battle` / `stackstack` |
| `attack-detection`  | 問題 stack に同梱した attack counter (CFn Output / SSM Parameter / CW metric 等) から検知数で加点。   | (`security-battle-royale` の防御側)|

旧 `uptime` は `uptime-flat` の legacy alias。 新規問題は `uptime-flat` を使う。

### Hints (progressive、 5 kind 共通)

`scoring.hints[]` に `{id, content, penalty}` を並べると、 portal で reveal するごとに `points` (flag) / `pointsPerSuccess` (uptime 系) / 累計 score (phased-polling / attack-detection) から減算される (Issue #742 Phase 5)。

## template.yaml

CloudFormation テンプレート。 ペライチで、 **このファイル単独**を競技アカウントに展開する (= S3 アップロードや nested stack は不要)。

### 必須パラメータ

deploy パイプラインがすべての問題テンプレートを同じ引数で起動できるよう、 次のパラメータをサポートする。

| パラメータ            | 必須 | 用途                                                                                              |
| --------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `NamePrefix`          | ○    | `tc-{problemSlug}-{teamSlug}` 形式の共通リソース prefix。 全リソース名 / タグに冠する。           |
| `TenkaCloudAccountId` | ○    | TenkaCloud 運営アカウント ID (12 桁)。 `ParticipantViewerRole` の trust に入る。                  |
| `ExternalId`          | ○    | `ParticipantViewerRole` AssumeRole 用の ExternalId (jobId)。 deploy chain が自動注入する。        |
| `AllowedCidr`         | -    | 公開ポートを許可する CIDR (default `0.0.0.0/0`)。                                                 |
| 問題固有パラメータ    | -    | `DbPassword` / `InstanceType` 等、 問題ごとに自由に追加してよい。                                 |

### 必須リソース

| リソース                  | 用途                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `ParticipantViewerRole`   | 競技者が AWS Console / CLI で AssumeRole する読み取り専用 IAM Role。 `${NamePrefix}-participant-viewer` の名前固定。 trust は `TenkaCloudAccountId:root` + `sts:ExternalId == ExternalId`。 ADR-021 に従い「自分の問題のリソースしか触れない」 IAM。 |

`ParticipantViewerRole` の policy 要件は [`infrastructure/test/problem-deploy/problem-template-participant-viewer-role.test.ts`](../infrastructure/test/problem-deploy/problem-template-participant-viewer-role.test.ts) で機械検証される (= `Resource: "*"` は tag-based Condition または metadata-only / self-identity API allowlist 必須)。

### 命名規約 (衝突回避)

同一 (Account, Region) に複数チームのスタックが共存する運用を想定する。 全リソース名 / タグ / グループ名は `${NamePrefix}` を冠する。

```yaml
Resources:
  MyVpc:
    Type: AWS::EC2::VPC
    Properties:
      Tags:
        - Key: Name
          Value: !Sub "${NamePrefix}-vpc"
        - Key: TenkaCloud:NamePrefix
          Value: !Ref NamePrefix
```

`TenkaCloud:NamePrefix` タグは `ParticipantViewerRole` の tag-based Condition (`aws:ResourceTag/TenkaCloud:NamePrefix`) を成立させるために、 競技者が見るすべてのリソースに付与する。

### 必須 Output

UI / 運営側 / scoring dispatcher が読むため、 次の Output を最低限含める。

| Output                       | 用途                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `NamePrefix`                 | deploy 時の引数 echo (operator デバッグ用)。                                                      |
| `ParticipantViewerRoleArn`   | `!GetAtt ParticipantViewerRole.Arn`。 portal の AWS Console ワンクリック login で AssumeRole される。 |
| 参加者向けエンドポイント URL | `FrontendUrl` / `ApiUrl` 等 (uptime / phased-polling 系)。 `endpoints[].outputKey` から参照される。 |
| `flagOutputKey` で指定した値 | scoring kind=flag のみ。 競技者が portal に貼り付ける値が出る。                                    |

## 新しい問題を追加する手順

scaffolding CLI を使うのが最短経路。 5 種の kind それぞれに雛形がある (`.claude/templates/problems/<kind>/`)。

```bash
# 1. 雛形を生成 (Battle uptime-flat の例)
bun run scripts/tenkacloud-problem.ts create my-new-problem --kind uptime-flat

# 2. metadata.json と template.yaml を編集

# 3. validate
bun run scripts/tenkacloud-problem.ts validate my-new-problem
make validate-problems

# 4. (任意) 動作確認
aws cloudformation deploy \
  --template-file problems/battles/my-new-problem/template.yaml \
  --stack-name tc-my-new-problem-test \
  --parameter-overrides NamePrefix=tc-my-new-problem-test TenkaCloudAccountId=<id> ExternalId=<jobId>
```

| サブコマンド                                       | 用途                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `tenkacloud-problem.ts list-kinds`                 | 利用可能な scoring kind と雛形を一覧。                              |
| `tenkacloud-problem.ts create <id> --kind <kind>`  | 雛形生成 (metadata.json + template.yaml + README skeleton)。       |
| `tenkacloud-problem.ts validate <id>`              | SCHEMA + cross-ref (endpoints の outputKey が CFn に存在するか等)。 |
| `tenkacloud-problem.ts inspect <id>`               | metadata + template + cross-ref を 1 画面に dump (= 設計レビュー用)。 |

Claude Code から使う場合は `/create-problem` skill が要件聞き取り → 雛形生成 → metadata 編集まで walk through する。

## カタログ生成パイプライン

問題追加 / 編集後、 次のチェックを通すと CI が緑になる (= `make before-commit` が走らせる)。

| step                                  | 内容                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `make validate-problems`              | `metadata.json` を `SCHEMA.json` で検証。                                                         |
| `make check-problems-index`           | `index.json` が `metadata.json` 群と一致するか check (drift 検知)。 編集後に `make build-problems-index` で再生成。 |
| `make check-template-ascii`           | template.yaml が ASCII + Latin-1 範囲内か (IAM Description の安全性)。                            |
| `make check-template-security`        | IAM / Security Group / S3 / KMS の危険パターン scan (例: `Action: "*"` + `Resource: "*"`)。       |
| `make check-template-cfn-refs`        | `!Ref` / `!GetAtt` の reference 整合 + `ParticipantViewerRole` 宣言の存在検証。                   |

`index.json` は `apps/admin-console` / `apps/application-admin-console` / `apps/participant-portal` の 3 SPA に build 時注入される (= metadata.json が UI 表示の正本)。

## i18n

サポート locale は **ja + en の 2 言語のみ** (Issue #1108 で es / zh は廃止)。

- 日本語 (default): top-level の `name` / `shortDescription` / `description` / `learningGoals` にそのまま入れる。
- 英語: `metadata.json` の `i18n.en` に override + `README.en.md` を同ディレクトリに置く。

英語版が無い問題 (= `i18n.en` 未設定) は portal の locale switcher を `en` に切り替えると default (ja) にフォールバックする。

## 関連ドキュメント

- [`SCHEMA.json`](./SCHEMA.json) — metadata.json JSON Schema (正本)
- [`docs/problems/AUTHORING.html`](../docs/problems/AUTHORING.html) — 30 分で 1 問書く onboarding (5 kind 決定木 + 4 worked example)
- [`docs/architecture/adr-012-problem-plugin-architecture.html`](../docs/architecture/adr-012-problem-plugin-architecture.html) — 3-asset model + thick metadata DSL + generic scoring dispatcher の設計
- [`infrastructure/templates/README.md`](../infrastructure/templates/README.md) — 競技者側 (competitor account) のセットアップ
- [`docs/gallery.md`](../docs/gallery.md) — 実装済み問題と次の候補を眺めるカタログ
