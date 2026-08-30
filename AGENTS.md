# AGENTS.md — TenkaCloud

TenkaCloud の AI エージェント向け作業契約です。実装方法を固定せず、platform boundary、安全、検証可能な完了条件を共有します。

## Repository

TenkaCloud は AWS 上の multi-tenant cloud competition platform です。Control Plane、Application Plane、problem deployment、participant / admin UI、problem pack tooling を所有します。problem content は `problems/` submodule の TenkaCloudChallenge が正本です。

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
- DynamoDB の capacity、Turso backend、Lite、SaaS の mode 差分と running cost を意識する。
- 破壊的操作、release、shared environment への変更、secret access は明示的な承認なしに行わない。
- test、type、lint、coverage、config を通すためだけに弱めない。rule または config が根本原因なら、証拠、test、regression analysis を伴って修正してよい。
- failure を空値、mock、silent fallback、偽の成功へ変換して隠さない。

## Verification

- commit 前に `make before-commit` を通す。
