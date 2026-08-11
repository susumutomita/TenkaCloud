# AGENTS.md — TenkaCloud

TenkaCloud の AI エージェント向け作業契約です。実装方法を固定せず、platform boundary、安全、検証可能な完了条件を共有します。

## Repository

TenkaCloud は AWS 上の multi-tenant cloud competition platform です。Control Plane、Application Plane、problem deployment、participant / admin UI、problem pack tooling を所有します。problem content は `problems/` submodule の TenkaCloudChallenge が正本です。

詳細は必要な範囲だけ読みます。

- architecture: [`docs/architecture/README.md`](./docs/architecture/README.md)
- judgment principles: [`docs/architecture/principles.md`](./docs/architecture/principles.md)
- machine enforcement: [`docs/architecture/enforcement-registry.md`](./docs/architecture/enforcement-registry.md)
- commands: [`Makefile`](./Makefile)

## Working contract

- 依頼、Issue、関連 stack、handler、UI、test から受け入れ条件を把握する。既存コードと履歴から解決できる曖昧さはリポジトリ内で確認する。
- 新しい helper、table、event、IAM permission、runtime config を足す前に既存実装と shared utility を検索する。
- 方法はタスクに合わせて選ぶ。専用 plan file、Skill、固定 role、固定人数の subagent、TDD の順序は必須ではない。
- apps、packages、scripts、infrastructure を必要な範囲で end-to-end に変更し、利用者から観測できる working increment を作る。
- 単純な修正を ceremony や multi-agent 化で膨らませない。trust boundary、migration、cross-plane、cost、physical impact が複雑な場合だけ独立探索や反証を使う。

## Platform guardrails

- tenant isolation、Cognito / JWT auth、mandatory `ExternalId`、IAM least privilege を維持する。
- `infrastructure/templates/competitor-bootstrap.yaml` の `AdministratorAccess` は competitor account bootstrap だけの明示的例外であり、他の role へ一般化しない。
- EventBridge bus、tenant onboarding、`DeployCreateRequested`、`runtime-config.json` の cross-plane contract を変更する場合は、producer と consumer を同じ PR で確認する。
- DynamoDB の capacity、Turso backend、Always-On、Lite、SaaS の mode 差分と running cost を意識する。
- 破壊的操作、release、shared environment への変更、secret access は明示的な承認なしに行わない。
- test、type、lint、harness、coverage、config を通すためだけに弱めない。rule または config が根本原因なら、証拠、test、regression analysis を伴って修正してよい。
- failure を空値、mock、silent fallback、偽の成功へ変換して隠さない。

## Verification

モデルが自分で成否を判定できる検証を先に見つけます。変更に最も近い unit、CDK assertion、API integration、browser preview、local problem play、synth を使います。

通常の PR gate は次の 2 コマンドです。

```bash
make harness
make before-commit
```

依存、CI、harness、cross-workspace contract、infrastructure の広い変更では full mirror を使います。

```bash
make ci-local
```

infra 変更では `make check-synth` と `Template.fromStack` assertion を使い、PR 本文の `## Physical impact` に CREATE / UPDATE / REPLACE / DELETE / NO-OP を記載します。live AWS でしか検証できない条件は、実行したように装わず one-time verification として明記します。

PR 本文には次を含めます。

- 変更内容を `Summary` に記載する。
- 実行した検証を `Validation` に記載する。
- 回帰確認を `Regression analysis` に記載する。
- 物理変更を `Physical impact` に記載する。
- 残る risk と未検証事項を記載する。

`/change`、`/review`、`/security-review`、`/simplify` などは必要なときだけ使う任意の補助であり、決定論的 gate の代わりでも必須入口でもありません。
