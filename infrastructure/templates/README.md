# TenkaCloud — 競技者向け事前セットアップ

## `competitor-bootstrap.yaml`

[`competitor-bootstrap.yaml`](./competitor-bootstrap.yaml) は、TenkaCloud から問題を
配置する競技者 AWS アカウントで、事前に 1 回実行する CloudFormation テンプレートです。
正本は従来どおり `infrastructure/templates/competitor-bootstrap.yaml` です。

競技者アカウントの初期設定は、これまでの 2 つの方法を使います。

- **AWS Organizations を利用する場合:** 管理者が service-managed StackSets で対象アカウントや OU へ一括配布する
- **Organizations を利用しない場合、または組織外のアカウント:** 各アカウントの所有者が個別に CloudFormation スタックを作成する

どちらも同じテンプレート、3 つのパラメータ、Competitor Accounts の登録・検証を使います。
問題本体の CloudFormation テンプレートは [`problems/`](../../problems/) にあります。

## セットアップ前に受け取る値

運営者は **Competitor Accounts** の **Add account** または **Bulk import** で
競技者アカウントを登録し、表示された次の値をアカウント所有者へ共有します。
登録だけでは IAM ロールは作成されません。

| パラメータ | 使用する値 |
| --- | --- |
| `TenkaCloudAccountId` | TenkaCloud 運営側の AWS アカウント ID（12 桁） |
| `ExternalId` | 同じ TenkaCloud 環境で共有する secret（16 文字以上） |
| `RoleName` | 登録画面に表示された正確なロール名 |

画面の `RoleName` をテンプレートのデフォルト値で置き換えないでください。
ExternalId をリポジトリ、チケット、公開テンプレート、コマンド履歴へ残さないでください。
表示を閉じた場合は [ExternalId の復旧手順](../README.md#externalid-recovery)を使います。

## Organizations を利用しない場合

1. アカウント所有者が、登録時に表示される **Launch Stack** を開く。
   Quick-create を使えない場合は、上記テンプレートをダウンロードし、競技者アカウントの
   CloudFormation で **Upload a template file** を選ぶ。
2. 運営者から受け取った 3 つの値を入力し、名前付き IAM リソースの作成を確認する。
   bootstrap 用のリージョンは、そのアカウントで 1 つだけ選ぶ。
3. `CREATE_COMPLETE` と Outputs の `RoleArn` を確認し、運営者へ完了を伝える。
4. 運営者が TenkaCloud の **Verify** で接続を確認する。

アカウントごとに同じ手順を繰り返します。Organizations、StackSets 用の実行ロール、
信頼されたアクセスの設定は不要です。

## Organizations で一括配布する場合

1. Organizations の全機能と、CloudFormation StackSets の信頼されたアクセスを確認する。
   管理アカウント、または登録済みの委任管理者から実行する。
2. 競技者用の対象アカウントと OU を選ぶ。TenkaCloud 運営側や無関係なアカウントは含めない。
3. **Service-managed permissions** の StackSet を作成し、同じ
   `competitor-bootstrap.yaml` と上記 3 つの値を指定する。
   自動配布は無効にし、選択した対象へ 1 リージョンだけに配布する。
4. StackSet の操作結果とアカウントごとの成功を確認する。
5. 未登録のアカウント ID を **Bulk import** で登録し、**Verify all** で接続を確認する。
   1 回の登録は 50 件まで。登録済みの行は重複として扱われ、他の行は続けて登録できる。

対象の絞り込み、CLI の実行例、失敗時の確認は
[Organizations / 個別設定の詳細手順](../../docs/competitor-account-onboarding.md)を参照してください。
既存の個別スタックがあるアカウントへ、同名ロールを作る StackSet を重ねて配布しないでください。

## アカウントとリージョン

チームには別々の AWS アカウント、または同じアカウントの別リージョンを割り当てられます。
IAM ロールはアカウント全体のリソースなので、競技者 bootstrap は各アカウントの
**1 リージョンにだけ作成**します。問題の配置先リージョンを増やしても再作成は不要です。
同一アカウントでは IAM などの共通リソースも共有するため、問題ごとの権限と分離を確認してください。

## 付与する権限と撤回

作成する配置ロールには、問題のリソースを作成・削除するための `AdministratorAccess` を付与します。
信頼先は運営側のアカウント ID と必須の `sts:ExternalId` に限定し、セッションは最大 1 時間です。
環境識別用のタグと表示されたロール名も維持します。この例外をアプリの実行ロールや
参加者ロールへ広げたり、TenkaCloud 運営側のアカウントへ配置したりしないでください。

撤回する前に、そのロールを使う問題リソースの削除を完了します。個別設定では bootstrap
スタックを削除します。StackSets では対象インスタンスを **スタックを保持せずに削除**し、
結果を確認します。登録行だけの削除や StackSet の定義だけの削除では、IAM ロールは消えません。
発行済みの STS 認証情報は期限まで有効な場合があります。

## クラウド基盤のセットアップ

[`cloud-pipeline.yaml`](./cloud-pipeline.yaml) は、運営側のクラウド基盤を配置する入口です。
競技者アカウントの初期設定とは別に、運営側では標準の `CDKToolkit` を使います。
[基盤の導入手順](../README.md)と [標準 CDK bootstrap](../BOOTSTRAP-IAM.md)を参照してください。
