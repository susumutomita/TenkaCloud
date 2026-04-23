# One-Pass AWS Acceptance

この文書は `ONE_PASS_AWS` の受け入れ条件です。local fallback を許さず、tenant runtime と competitor AWS account runtime を分けた本番形で確認します。

## 前提

- `AUTH_SKIP` は無効
- Control Plane は tenant manager として動作する
- Application Plane は tenant ごとに 1 つ配備されている
- competitor AWS accounts に `AssumeRole + ExternalId` で入れる
- 問題テンプレートは CloudFormation を持つ
- `docs/architecture/harness.md` の invariant を破らない

## 手順

1. Control Plane で tenant を作成する（SBT API Gateway へ `POST /tenants` フラット payload。詳細は [ADR-013](../decisions/013-sbt-control-plane-onboarding-wire-format.md)）
2. provisioning を開始し、SBT が返す `tenantStatus="Complete"`（UI 上は `provisioningStatus=COMPLETED`）と tenant runtime descriptor を確認する
3. tenant ごとの Application Plane endpoint に到達できることを確認する
4. Application Plane admin で event を作成し `active` にする
5. competitor account を event に登録する
6. AWS provider の GameDay 問題を event に関連付ける
7. `POST /admin/events/:eventId/problems/:problemId/deploy` を実行する
8. deployment jobs が `completed` になり、stack outputs が永続化されることを確認する
9. participant として event に参加し team membership を確立する
10. `attack / defense / vote` が deploy record と runtime state を前提に動くことを確認する
11. `GET /api/participant/events/:eventId/aws-console` が STS federation URL を返すことを確認する

## 期待値

- Control Plane は tenant lifecycle と deployment status のみを見る
- 問題 runtime は platform account ではなく competitor AWS accounts に存在する
- tenant Application Plane endpoint は shared localhost URL ではなく tenant descriptor から解決される
- `aws-console` は 404 ではなく有効な `url` と `expiresAt` を返す
- local fallback ではなく、実認証・実 runtime で一気通貫する

## 失敗時の見方

- provisioning で止まる場合
  tenant runtime descriptor と `applicationDeploymentStatus` を確認する
- deploy job が失敗する場合
  competitor account の `roleArn`, `externalId`, CloudFormation template, stack outputs 保存を確認する
- participant 画面が動かない場合
  deploy record が participant runtime に反映されているかを確認する
