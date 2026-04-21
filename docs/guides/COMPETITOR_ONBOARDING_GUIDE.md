# 競技者 AWS アカウント オンボーディング

TenkaCloud の GameDay に自分の AWS アカウントで参加するためのセットアップ手順です。イベント主催者（Admin）から以下の 2 つを先に受け取ってください。

1. **TenkaCloud 管理アカウント ID**（12 桁）
2. **External ID**（`tc-<eventId>-<accountId>` 形式）

主催者がまだ発行していない場合は「競技アカウントを追加」画面であなたの AWS アカウント ID を入力してもらい、生成された値を共有してもらってください。

## 何をするのか

競技者アカウントに **TenkaCloud 管理アカウントが AssumeRole できる IAM Role** を作成します。TenkaCloud はこの Role を介して GameDay 問題の CloudFormation スタックをあなたのアカウントにデプロイします。Confused Deputy 対策として **External ID** を condition に入れるため、ExternalId を把握していない第三者は Role を引き受けられません。

作成されるのは次のリソースのみです。

- `TenkaCloudDeployRole`（IAM Role）
  - Principal: TenkaCloud 管理アカウントの root
  - Condition: `sts:ExternalId` が一致する
  - 権限: `AdministratorAccess`（デフォルト）または `PowerUserAccess`（限定）

イベント終了後はスタックを削除すれば Role も消えます。

## デプロイ方法

### AWS マネジメントコンソール

1. [コンソールの CloudFormation ページ](https://console.aws.amazon.com/cloudformation/home)にログイン
2. 「スタックの作成」→「新しいリソースを使用 (標準)」
3. 「テンプレートファイルのアップロード」で [`infrastructure/templates/competitor-deploy-role.yaml`](../../infrastructure/templates/competitor-deploy-role.yaml) を選択
4. スタック名: `tenkacloud-deploy-role`
5. パラメータ:
   - **TenkaCloudManagementAccountId**: 主催者から受け取った 12 桁の ID
   - **ExternalId**: 主催者から受け取った `tc-<eventId>-<accountId>` 形式の値
   - **RoleName**: そのまま `TenkaCloudDeployRole`
   - **PermissionMode**: `Admin`（ほとんどの問題に必要）
6. 「IAM リソースを作成することを承認する」にチェック
7. 「スタックの作成」

作成が完了したら「出力」タブの `RoleArn` をコピーしてください。

### AWS CLI

```bash
aws cloudformation create-stack \
  --stack-name tenkacloud-deploy-role \
  --template-body file://infrastructure/templates/competitor-deploy-role.yaml \
  --parameters \
      ParameterKey=TenkaCloudManagementAccountId,ParameterValue=<MANAGEMENT_ACCOUNT_ID> \
      ParameterKey=ExternalId,ParameterValue=<EXTERNAL_ID> \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation wait stack-create-complete --stack-name tenkacloud-deploy-role

aws cloudformation describe-stacks \
  --stack-name tenkacloud-deploy-role \
  --query 'Stacks[0].Outputs' \
  --output table
```

## 主催者に伝える内容

スタックの「出力」（または `describe-stacks`）から以下を主催者に共有してください。

| 項目 | 値 |
| --- | --- |
| AWS アカウント ID | `RoleArn` の 5 セグメント目の 12 桁 |
| Role ARN | `arn:aws:iam::<YOUR_ACCOUNT>:role/TenkaCloudDeployRole` |
| External ID | セットアップ時に入力した値 |
| リージョン | 主催者に指定されたリージョン（例: `ap-northeast-1`） |

主催者はこれらを Application Plane の「競技アカウント追加」画面に入力します。

## セキュリティ上の注意

- `AdministratorAccess` は広い権限である。GameDay 用の **専用 AWS アカウント**（メインで使っているアカウントと分ける）を用意することを強く推奨する。
- External ID を **Slack / メール以外の暗号化された手段**（1Password / Bitwarden / Signal など）で共有すること。漏洩しても Principal 一致が必要なので単独での悪用は難しいが、管理アカウントが侵害された場合の防御が薄くなる。
- 監査ログは競技者側の CloudTrail に残る。TenkaCloud が実行したアクションは `userIdentity.arn` に `TenkaCloudDeployRole` が記録される。

## 片付け

イベント終了後の手順は次の通りです。

1. TenkaCloud 側で作成された問題スタック（`tenkacloud-problem-*-team-*` など）を先に削除（主催者が一括削除するか、コンソールから手動）。
2. このテンプレで作った `tenkacloud-deploy-role` スタックを削除。

```bash
aws cloudformation delete-stack --stack-name tenkacloud-deploy-role
aws cloudformation wait stack-delete-complete --stack-name tenkacloud-deploy-role
```

## トラブルシューティング

**主催者側で「AssumeRole returned no credentials」エラー**

- External ID が一致していない可能性がある。主催者に問い合わせて再確認する。
- あるいは `TenkaCloudManagementAccountId` が違う。

**「Missing roleArn or externalId for account &lt;id&gt;」で即失敗**

- 競技アカウントが Role ARN 付きで登録されていない。主催者が「競技アカウント追加」時に Role ARN 欄を空欄にしていた可能性があるため、再登録してもらう。`<id>` はデプロイジョブが参照した competitor account ID。

**CloudFormation の CREATE_FAILED**

- スタック名の重複: 同名のスタックが残っているので `delete-stack` してから再実行する。
- 既存の IAM Role 名衝突: `RoleName` パラメータを別の値にするか、既存ロールを削除する。
