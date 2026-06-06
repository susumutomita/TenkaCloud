# TenkaCloud — 競技者向け事前セットアップ

このディレクトリは、TenkaCloud から問題を deploy される側 (= 競技者) の AWS アカウントで
事前に 1 回だけ流す CloudFormation テンプレートを置く。

## `competitor-bootstrap.yaml`

### これは何か

TenkaCloud の Deploy Lambda が、競技者 AWS アカウントへ問題 CFn (`problems/<id>/template.yaml`) を
deploy するために使う **IAM Role** を作るテンプレート。
trust policy は TenkaCloud control-plane アカウント ID + ExternalId に限定し、
それ以外の主体からの AssumeRole を拒否する。

### セットアップ手順

#### 1. TenkaCloud 運営者から以下を受け取る

- **TenkaCloudAccountId**: TenkaCloud の control-plane が動く AWS アカウント ID (12 桁)
- **ExternalId**: テナント固有の External ID (16 文字以上の secret)

#### 2. 競技者 AWS アカウントでテンプレートを deploy

CLI で実行する場合は次の通りです。

```bash
aws cloudformation deploy \
  --template-file infrastructure/templates/competitor-bootstrap.yaml \
  --stack-name tenkacloud-competitor-bootstrap \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      TenkaCloudAccountId=123456789012 \
      ExternalId=share-this-secret-with-tenkacloud
```

Console から流す場合は CFn →「スタックの作成」→ テンプレート yaml を upload →
パラメータ入力 →「IAM 権限変更を承認」にチェックして実行します。

#### 3. 出力された RoleArn を TenkaCloud 運営者に共有

deploy 完了後、CFn Outputs に表示される `RoleArn` を TenkaCloud 運営者に伝える。
TenkaCloud 側はこの ARN と ExternalId を用いて AssumeRole し、問題 CFn を本アカウントへ
展開できるようになる。

### 付与される権限

作成される Role に対し、問題 CFn が必要とする次の権限を付与します。

| サービス       | スコープ                                         | 用途                                   |
| -------------- | ------------------------------------------------ | -------------------------------------- |
| CloudFormation | `*`                                              | 問題スタックの create / update / delete |
| EC2 / VPC      | `*`                                              | 問題 CFn が VPC + EC2 を立てる         |
| SSM            | `GetParameter*` / `DescribeParameters`           | AMI ID 解決 / セッションマネージャ     |
| IAM            | `tc-*` の Role / Instance Profile のみ           | 問題 CFn が EC2 instance profile を作る |
| S3             | `tc-*` バケット / オブジェクト                   | 将来の S3 利用問題向け                 |
| CloudWatch Logs| `*`                                              | 診断ログ                               |

権限スコープは問題 CFn が実際に必要とするものに合わせて広めに付与している (`ec2:*` など)。
最小権限化は問題テンプレートが固まった後に絞る方針。

### 撤回 / クリーンアップ

このスタックを削除すると Role も消える ⇒ TenkaCloud からの AssumeRole が即時に拒否される。

#### 競技後の片付け (推奨)

競技を終えたら、 必ず stack を削除してください。 残したままにすると TenkaCloud
運営側が AssumeRole 可能な状態が継続します (= 攻撃面 + コスト両面でクリーンに
保つため)。

##### 方法 A: CLI で 1 行削除 (推奨)

```bash
aws cloudformation delete-stack --stack-name tenkacloud-competitor-bootstrap
# 削除完了を待つ場合 (option):
aws cloudformation wait stack-delete-complete --stack-name tenkacloud-competitor-bootstrap
```

##### 方法 B: AWS Console から削除

1. AWS Console > CloudFormation > スタック一覧
2. `tenkacloud-competitor-bootstrap` を選択
3. 「削除」→「スタックの削除」を確認

Console / CLI どちらの経路でも結果は同じ (= IAM Role が即時消える)。 Issue #840 は
Participant Portal 側に「環境を片付ける」button を追加して同操作を 1-click 化する
予定ですが、 現状は上記いずれかを競技者ご自身で実行してください。

#### 即時撤回 (競技中の trust 取り消し)

万が一 External ID が漏れた場合などは、 競技中でも上記コマンドで stack を削除して
trust を即時撤回できます。 削除後はあらためて生成した External ID で再 deploy
すれば trust が復旧します。

### セキュリティ上の前提

- **External ID は secret として扱う**。Confused Deputy 攻撃を防ぐため、TenkaCloud 運営者と
  競技者だけが知っている値である必要がある。
- TenkaCloud の Deploy Lambda は CloudTrail に AssumeRole 履歴を残す。競技者は自身の
  CloudTrail でその AssumeRole / 後続の CFn / EC2 操作を監査できる。
- スタック削除で権限を即時撤回できるので、競技終了後はスタックを消すと安全。

## One-click Lite mode deployment pipeline

### 概要

`lite-pipeline.yaml` は、README の **Launch Stack** ボタンから 1 クリックで起動できる
独立したペライチ CloudFormation テンプレート。CDK アプリとは切り離されており、
作るのは「デプロイ用パイプライン」だけ (= TenkaCloud 本体のスタックはパイプラインの
Build ステップが `make deploy` を実行して作る)。

パイプライン構成: `Source (GitHub) → Manual Approval (任意) → Build (CodeBuild で make deploy)`。
CodeBuild は repo を clone → `bun install` → `make build` → `cdk bootstrap` → Lite mode の
`make deploy` を流す。`infrastructure/environments/<env>/.env` はビルド中に
`TenantAdminEmail` パラメータから自動生成される。

### 事前準備 (1 回だけ)

GitHub への OAuth ハンドシェイクだけは CloudFormation で自動化できないため、
**CodeStar Connection** を先に手動で作る。

1. AWS Console → Developer Tools → Connections →「Create connection」→ GitHub を選択
2. 認可フローを完了し、ステータスが **Available** になった接続の ARN を控える

### デプロイ手順

1. README の [Launch Stack](../../README.md#option-a--one-click-deploy-cloudformation) ボタンを押す (または Console の CloudFormation でこの yaml を upload する)
2. 下表のパラメータを入力する
3. 「IAM 権限変更を承認」にチェックして作成する。スタック作成時にパイプラインが 1 回自動実行されるので、承認ステージで承認すれば Lite デプロイが走る

| パラメータ            | 必須 | 説明                                                          |
| --------------------- | ---- | ----------------------------------------------------------- |
| `TenantAdminEmail`    | 必須 | Application Admin Console の初期ユーザー宛先                 |
| `GitHubConnectionArn` | 必須 | 上で控えた CodeStar Connection の ARN                       |
| `GitHubRepositoryId`  | 任意 | デフォルト `susumutomita/TenkaCloud` (fork したなら自分の owner/repo) |
| `EnableManualApproval`| 任意 | `false` にすると承認なしの完全自動デプロイ                  |
| `DeployExternalId`    | 任意 | 競技者アカウントへ AssumeRole する場合のみ                  |

完了後、CodeBuild ログ末尾に Application Admin Console / Participant Portal の URL が出る。
パイプライン自体は CloudFormation スタックを削除すれば消える (TenkaCloud 本体は
`make destroy` で別途撤去する)。

### コストの注意

問題テンプレート (`problems/**/template.yaml`) は AWS 無料枠 0 円に収めているが、
このパイプラインは CodePipeline V2 + CodeBuild + 小さな S3 を使うため厳密な 0 円ではない
(月数回のデプロイで 1 ドル未満)。使い終えたらスタックを削除すれば課金は止まる。

## 関連

- [`/problems/README.md`](../../problems/README.md) — 問題カタログ規約
- [`/problems/battles/security-battle-royale/template.yaml`](../../problems/battles/security-battle-royale/template.yaml) — 実際に deploy される問題 CFn の例
