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

## CloudFormation console Lite mode deployment pipeline

### 概要

`lite-pipeline.yaml` は、手元に Bun / CDK を入れずに Lite mode を deploy するための単一
CloudFormation テンプレートです。テンプレート自体は TenkaCloud 本体を作らず、**CodeBuild
プロジェクトを 1 つ**作ります。スタック作成後に「Start build」を押すと、CodeBuild が public
な TenkaCloud repo と問題カタログ repo を `git clone` し、`make deploy` で Lite mode stack を
作ります。`infrastructure/environments/<env>/.env` はビルド中に `TenantAdminEmail` から
自動生成されます。

TenkaCloud は public OSS なので **GitHub connection は不要**（CodeBuild が直接 clone する）。
CodePipeline も使いません。問題カタログは Git submodule ではなく `ProblemsRepoUrl`
パラメータで選ぶので、第三者は自分のカタログ repo を指定して deploy できます。

> CloudFormation の `templateURL` は Amazon S3 URL のみ対応です。GitHub raw URL を直接渡す
> Launch Stack ボタンは `TemplateURL must be a supported URL` になるため、README では
> **Upload a template file** 手順を正式手順にしています。

### デプロイ手順

1. README の [AWS Console (no local install)](../../README.md#a-aws-console-no-local-install) から `lite-pipeline.yaml` を download する
2. Console の CloudFormation で **Upload a template file** を選び、この yaml を upload する
3. 下表のパラメータを入力する
4. 「IAM 権限変更を承認」にチェックしてスタックを作成する
5. スタックの `StartBuildConsoleUrl` 出力から CodeBuild プロジェクトを開き、**Start build** を押す（デプロイは 15-30 分程度）

| パラメータ | 必須 | 説明 |
| --- | --- | --- |
| `Environment` | 任意 | `development` / `staging` / `production`。対応する config.json / .env を使う |
| `TenantAdminEmail` | 必須 | Application Admin Console の初期ユーザー宛先 |
| `ProblemsRepoUrl` | 任意 | 載せる問題カタログ repo。デフォルトは公式 TenkaCloudChallenge。自分の fork を指定すれば自分の問題で deploy できる |
| `ProblemsRepoRef` | 任意 | カタログの branch / tag。デフォルト `main` |
| `RepoUrl` / `RepoRef` | 任意 | 本体 repo と branch / tag（デフォルトは公式 repo の `main`）。fork のときだけ上書き |
| `DeployExternalId` | 任意 | 競技者アカウントへ AssumeRole する場合のみ |
| `BunVersion` | 任意 | CodeBuild に install する Bun。デフォルトは repo toolchain と同じ `1.3.11` |
| `CodeBuildTimeoutMinutes` | 任意 | CodeBuild timeout。デフォルトは 90 分 |

完了後、Application Admin Console / Participant Portal の URL は `tenkacloud-lite` /
`tenkacloud-lite-problem-deploy` スタックの CloudFormation **Outputs** に出ます。CodeBuild
プロジェクトは CloudFormation スタックを削除すれば消える（TenkaCloud 本体は `make destroy`
で別途撤去する）。

> **自分の問題で deploy する場合:** [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)
> を fork し（`scripts/new-problem.ts`・schema・validation が同梱）、そこで作問してから
> `ProblemsRepoUrl` に自分の fork を指定する。本体の fork は不要。

### コストの注意

問題テンプレート (`problems/**/template.yaml`) は AWS 無料枠 0 円に収めているが、この
デプロイは CodeBuild (build-minute 課金) を使うため厳密な 0 円ではない（月数回のデプロイで
1 ドル未満）。使い終えたらスタックを削除すれば課金は止まる。

## 関連

- [`/problems/README.md`](../../problems/README.md) — 問題カタログ規約
- [`/problems/battles/security-battle-royale/template.yaml`](../../problems/battles/security-battle-royale/template.yaml) — 実際に deploy される問題 CFn の例
