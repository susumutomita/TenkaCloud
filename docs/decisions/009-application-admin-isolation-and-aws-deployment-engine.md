# ADR-009: Application 管理者分離と AWS 問題デプロイメントエンジン

- **Status**: Accepted
- **Date**: 2026-04-12
- **Deciders**: susumutomita

## Context

Application Plane では、ローカル開発時の `AUTH_SKIP` が常に管理者権限を持つ形になっており、参加者向け UI と管理者 UI の境界が崩れていた。これにより `/admin` 配下へ誰でも入れる状態になり、実際の権限モデルとローカル挙動が乖離していた。

また、GameDay 問題のチーム配布は UI 上の導線は存在する一方で、AWS 連携は placeholder 実装に留まっていた。競技者 AWS アカウントへ安全に問題を配布するには、各アカウントの IAM Role を `ExternalId` 付きで引き受け、CloudFormation テンプレートを tenant/event/problem 単位で展開する実行系が必要だった。

## Decision

1. Application Plane の `AUTH_SKIP` デフォルトロールは `participant` とし、管理者権限は `AUTH_SKIP_ROLES` で明示的に付与する
2. 管理者 UI、middleware、server API helper では共通ヘルパーで管理者判定を共有し、`admin` / `platform-admin` / `tenant-admin` / `organizer` のみを管理者とみなす
3. backend services でも同様に `AUTH_SKIP` デフォルトロールを最小権限へ寄せ、参加者系 service は `participant`、problem-service は `competitor` をデフォルトにする
4. 競技者アカウントには `externalId` を保持できるようにし、未指定時は `eventId` と account ID から安全な値を自動生成する
5. AWS deployment engine は placeholder を廃止し、AWS SDK を使った実実装へ置き換える
   - STS `AssumeRole` + `ExternalId`
   - STS `GetCallerIdentity` による credential 検証
   - CloudFormation `ValidateTemplate` / `CreateStack` / `DescribeStacks` / `DescribeStackResources` / `DeleteStack`
   - S3 `PutObject`
6. GameDay deployer は competitor account ごとに job を永続化し、stack 名・parameter・tag を組み立てて並列デプロイする

## Consequences

- **Good**: ローカル開発でも参加者と管理者の境界が壊れなくなる。UI の見え方と本番権限モデルが揃う。問題配布が console log ベースではなく、実際に AWS アカウントへ到達する経路になる。
- **Bad**: ローカルで管理者画面を確認するには `AUTH_SKIP_ROLES` の明示が必要になる。競技者アカウント設定では `roleArn` と信頼ポリシーに加えて `ExternalId` の整合も必要になる。
- **Tradeoff**: 開発初速は少し落ちるが、誤った権限前提やハリボテ deploy で機能が成立したように見える状態は防げる。

## References

- [apps/application-plane/auth.ts](../../apps/application-plane/auth.ts)
- [apps/application-plane/lib/auth/roles.ts](../../apps/application-plane/lib/auth/roles.ts)
- [apps/application-plane/proxy.ts](../../apps/application-plane/proxy.ts)
- [backend/services/application-plane/problem-service/src/auth/index.ts](../../backend/services/application-plane/problem-service/src/auth/index.ts)
- [backend/services/application-plane/problem-service/src/problems/gameday-deployer.ts](../../backend/services/application-plane/problem-service/src/problems/gameday-deployer.ts)
- [backend/services/application-plane/problem-service/src/providers/aws/index.ts](../../backend/services/application-plane/problem-service/src/providers/aws/index.ts)
