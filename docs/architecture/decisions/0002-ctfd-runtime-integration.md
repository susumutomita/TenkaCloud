# ADR-0002: CTFd と TenkaCloud の問題ランタイム連携境界

- **Status**: Proposed
- **Date**: 2026-08-28
- **Deciders**: Susumu Tomita (`@susumutomita`)
- **Tracked by**: [Issue #3094](https://github.com/susumutomita/TenkaCloud/issues/3094)

## Context

TenkaCloud #0 の参加者から、CTFd を競技 UI / 採点基盤として使いながら、問題環境のデプロイとライフサイクルだけを TenkaCloud に委譲したいという要望が出た。現在の CTF 運営では、EC2 上で CTFd を起動し、問題コンテナを個別に操作する構成もあり、問題ランタイムの払い出し・停止・回収を TenkaCloud に任せられると運営負荷を下げられる。

この連携は CTFd を TenkaCloud に置き換えるものではない。また、TenkaCloud の Participant Portal と CTFd を二重に参加者 UI として使う構成も採用しない。責務を明確に分け、既存の TenkaCloud Machine API とデプロイ基盤を可能な限り再利用する。

この ADR は外部プロダクトとの境界を先に固定する必要があるため、`docs/architecture/README.md` の narrow exception に該当する。

## Decision

### 1. 責務分担

| 領域 | CTFd | TenkaCloud |
| --- | --- | --- |
| 参加者・チーム管理 | 正本 | 連携用の対応 ID のみ保持 |
| Challenge 表示 | 正本 | 問題カタログ / runtime metadata を提供 |
| Flag 判定・得点・scoreboard | 正本 | CTFd 連携では担当しない |
| 問題環境の作成 | 呼び出し元 | 正本 |
| AWS account / region / role / ExternalId | 参照のみ | 正本 |
| endpoint readiness / deployment status | 表示用に取得 | 正本 |
| 問題環境の停止・削除 | 要求を出す | 実行と所有権の正本 |
| cleanup / orphan recovery | 状態表示のみ | 正本 |
| runtime audit | 相関 ID を記録 | 正本 |

参加者は CTFd の Challenge 画面だけを使う。TenkaCloud Participant Portal の team key、flag submission、scoreboard はこの統合では使わない。

### 2. 既存 Machine API を start / read の正本として再利用する

現在の Machine API は `TenantMachine` principal に対して次を既に提供している。

- `POST /problems/{problemId}/deploy` — 1 team / 1 problem のデプロイ開始
- `GET /deployments/{jobId}` — deployment 状態取得
- `GET /deployments/{jobId}/stack-progress` — CloudFormation 進捗取得
- `GET /problems/{problemId}/deployments` — 問題単位の deployment 一覧
- `GET /events` / `GET /events/{eventId}` — event 参照
- `POST /deployments/retry` — FAILED deployment の再投入

この route allowlist は `MACHINE_ROUTE_SCOPES` が単一の正本であり、machine principal には destructive route を意図的に公開していない。CTFd 連携のために、この境界を迂回して管理者 JWT や Cognito local administrator credential を plugin に渡してはならない。

### 3. teardown は専用の bounded seam として設計する

CTFd 連携に必要な最小ライフサイクルは `start -> status -> endpoint -> stop` である。しかし現在の Machine API は destructive teardown を machine principal に許可しない。

したがって PoC で管理者 API を直接呼ぶのではなく、次のどちらかを後続実装で選ぶ。

1. event / integration lease に束縛された専用 teardown capability を追加する。
2. TenkaCloud 側の integration facade が stop request を受け、内部の既存 teardown service を呼ぶ。

どちらの場合も、任意 `jobId` を削除できる credential にはしない。少なくとも `tenantId + integrationId + externalTeamId + externalChallengeId + deploymentJobId` の対応関係を TenkaCloud 側で検証し、自分が作成した runtime だけを削除できるようにする。

### 4. ID mapping

CTFd の数値 ID や表示名を TenkaCloud の主キーとして使わない。integration namespace 内で次の対応を保持する。

```text
integrationId
  + externalTeamId
  + externalChallengeId
      -> problemId
      -> deploymentJobId
      -> runtime state
```

- `integrationId`: CTFd instance / event ごとの TenkaCloud 側 ID
- `externalTeamId`: CTFd の team ID を opaque string として保存
- `externalChallengeId`: CTFd の challenge ID を opaque string として保存
- `problemId`: TenkaCloud catalog の immutable problem ID
- `deploymentJobId`: TenkaCloud が発行した deployment job ID

CTFd の team name / challenge name は表示用 metadata であり、identity や authorization の根拠にしない。

### 5. 最小フロー

```text
CTFd plugin
  | OAuth2 client_credentials
  v
TenkaCloud Machine API
  | POST /problems/{problemId}/deploy
  v
Deployment pipeline
  | jobId
  v
CTFd plugin
  | GET /deployments/{jobId}
  | poll until COMPLETE
  v
CTFd challenge instance
  | endpoint を参加者へ表示
  v
CTFd scoring

CTFd stop / challenge expiry
  |
  v
bounded teardown seam (follow-up)
  |
  v
TenkaCloud teardown owner
  -> DELETED
```

CTFd plugin は CloudFormation や Docker を直接操作しない。TenkaCloud の deployment job が runtime ownership の正本である。

### 6. Authentication / authorization

- CTFd plugin は TenkaCloud の per-tenant Machine API credential を使う。
- credential は OAuth2 `client_credentials` で短寿命 access token を取得する。
- start には `tenkacloud/ops.deploy`、poll には `tenkacloud/ops.read` を使う。
- teardown capability は既存 `ops.write` をそのまま destructive delete へ拡張しない。別 capability または integration facade 内の lease-bound authorization とする。
- CTFd の webhook secret や API key を TenkaCloud の browser client に渡さない。
- TenkaCloud の admin credential / participant team key を CTFd plugin に保存しない。

### 7. Idempotency と再試行

`POST /problems/{problemId}/deploy` の既存 `Idempotency-Key` を必須利用とする。キーは CTFd request ごとに十分ランダムな値を生成し、同一 request の network retry では同じ値を再送する。

plugin が timeout した場合、同じ idempotency key で再送して二重 runtime 作成を避ける。FAILED job の再試行は既存 `POST /deployments/retry` の契約に従う。

### 8. Endpoint の扱い

CTFd に返すのは、TenkaCloud が COMPLETE deployment から公開してよいと判断した participant-facing endpoint だけとする。CloudFormation の全 Output、role ARN、ExternalId、内部 scoring endpoint を plugin へ丸ごと返さない。

必要なら後続実装で `DeploymentRuntimeView` のような projection を追加し、`deploymentJobId`, `status`, `participantEndpoint`, `expiresAt` の bounded shape にする。

### 9. Teardown ownership

次のいずれかで stop を開始しても、最終的な削除実行と state transition の所有者は TenkaCloud とする。

- CTFd operator が stop を押す。
- challenge / event の終了時刻に達する。
- TenkaCloud operator が緊急停止する。
- integration lease が期限切れになる。

CTFd 側で「削除済み」と表示するのは TenkaCloud が `DELETED` を返した後だけとする。stop request の HTTP success を cleanup 完了とみなさない。

## PoC scope

Issue #3094 の最小 PoC は次に限定する。

1. CTFd plugin または小さな adapter が TenkaCloud Machine API token を取得する。
2. 既存の `POST /problems/{problemId}/deploy` で 1 problem を開始する。
3. `GET /deployments/{jobId}` を poll する。
4. COMPLETE 後に bounded participant endpoint を CTFd challenge instance へ反映する。
5. CTFd の flag 判定 / scoreboard は CTFd のまま使う。
6. stop は teardown seam が実装されるまでは operator-driven TenkaCloud cleanup とし、自動削除できると主張しない。

PoC では CTFd core を fork しない。まず plugin / adapter として実装し、責務境界を検証する。

## Non-goals

- CTFd の scoring engine を TenkaCloud に移植すること。
- TenkaCloud Participant Portal を CTFd iframe として埋め込むこと。
- CTFd へ AWS administrator credential を渡すこと。
- CTFd plugin から raw CloudFormation / Docker API を実行すること。
- Machine API の destructive deny-by-default を雑に解除すること。
- 初期 PoC で複数 CTFd vendor / SaaS deployment を抽象化すること。

## Follow-up implementation gates

- [ ] bounded runtime projection を既存 deployment response で満たせるか確認する。足りなければ dedicated read projection を追加する。
- [ ] lease-bound teardown seam と capability を実装する。
- [ ] external ID mapping の永続化と tenant isolation test を追加する。
- [ ] deploy idempotency / retry / stop retry の contract test を追加する。
- [ ] CTFd plugin の credential storage / redaction を確認する。
- [ ] orphan cleanup と event expiry の ownership を smoke test する。

## Consequences

### Positive

- CTFd は得意な参加者 UI と scoring を維持できる。
- TenkaCloud は問題環境の deployment / lifecycle に集中できる。
- 既存 Machine API と OAuth2 scope 境界を再利用できる。
- CTFd plugin に広い TenkaCloud 管理者権限を渡さない。

### Trade-offs

- 現状 Machine API に safe teardown seam が無いため、完全自動 lifecycle は後続実装が必要。
- CTFd と TenkaCloud の ID mapping を新たに保持する必要がある。
- endpoint projection を追加する場合、Machine API の公開契約を拡張するレビューが必要になる。
