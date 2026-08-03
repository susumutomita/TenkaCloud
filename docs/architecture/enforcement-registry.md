# TenkaCloud Enforcement Registry

この文書は、AI エージェントの遵守に委ねず、機械的に強制する rule と gate の人間向け索引です。

判断原則は [Principle Registry](./principles.md) を正本とします。architecture rule の機械可読 metadata は [enforcement-rules.json](./enforcement-rules.json) を正本とし、`agent-registry-consistency` が principle、implementation、test、本表との drift を CI で拒否します。

## 登録要件

新しい禁止や必須条件を追加するときは、最初に機械判定可能かを判断します。可能な場合は散文だけへ追加せず、次を同じ PR に含めます。

- rule ID。
- 対応する principle ID。
- implementation path。
- execution timing。
- scope と severity。
- 正常、違反、境界、誤検知防止の test。
- 正当な例外の手続き。
- `enforcement-rules.json` と本表の更新。

## Architecture harness

| Rule ID | Principle | Scope | Severity |
| --- | --- | --- | --- |
| `adr-must-be-html` | `PRINCIPLE_EXPLICIT_GAPS` | architecture decision records | error |
| `adr-self-contained` | `PRINCIPLE_EXPLICIT_GAPS` | architecture decision records | error |
| `agent-registry-consistency` | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | principle / enforcement / rule metadata | error |
| `domain-no-infra-import` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | control-data domain | error |
| `file-too-large` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | application / infrastructure source | warning / error |
| `handler-must-not-call-fetch` | `PRINCIPLE_FAIL_LOUDLY_AT_BOUNDARIES` | handler | error |
| `handler-no-direct-sdk-import` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | Lambda entrypoint | error |
| `handler-no-transitive-cdk-import` | `PRINCIPLE_PHYSICAL_EFFECTS_ARE_BEHAVIOR` | Lambda runtime dependency graph | error |
| `handler-tenant-isolation` | `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY` | tenant-scoped DDB handler | error |
| `hook-command-target-exists` | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | `.claude/settings.json` local script targets | error |
| `iam-wildcard-needs-justify` | `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY` | IAM policy | error |
| `lambda-env-size` | `PRINCIPLE_PHYSICAL_EFFECTS_ARE_BEHAVIOR` | synthesized Lambda environment | warning / error |
| `no-aws-trademark-fictions` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | public content | error |
| `no-conflict-markers` | `PRINCIPLE_COMPLETION_REQUIRES_AUDIT` | repository text | error |
| `runtime-composition-root-only` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | control-data runtime composition | error |
| `secrets-manager-forbidden` | `PRINCIPLE_COST_IS_AN_ARCHITECTURE_CONSTRAINT` | AWS SDK import | error |

`handler-tenant-isolation` は、tenant logic を handler から禁止する rule ではありません。tenant-scoped handler が DDB command を発行するとき、同一 file で `tenantId` の参照を要求します。これにより、partition key や condition に tenant boundary を入れ忘れる問題を検知します。

`hook-command-target-exists` は、Claude Code settings の `command` を走査します。`.claude/` または `scripts/` 配下の local script target が実在することを確認し、削除済み script を参照する stale hook を commit 前と CI で止めます。

`agent-registry-consistency` は次を同時に検査します。

- `PRINCIPLE_*` ID の重複。
- manifest から存在しない principle、implementation、test への参照。
- Rule object と manifest の ID / severity drift。
- manifest に登録されていない architecture rule。
- manifest と本表の行 drift。
- enforcement または review coverage に一度も紐付かない principle。

## Quality gates and review coverage

| Gate | Principle | Timing | Purpose |
| --- | --- | --- | --- |
| Biome | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | edit / pre-commit / CI | syntax、format、unsafe construct |
| type-aware ESLint | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | pre-commit / CI | scripts の型情報が要る検査 |
| textlint / markdownlint | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | pre-commit / CI | public documentation quality |
| Vitest | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | local / CI | behavior and regression |
| coverage gate | `PRINCIPLE_COMPLETION_REQUIRES_AUDIT` | CI | agent-owned workspace coverage |
| CDK `Template.fromStack` | `PRINCIPLE_PHYSICAL_EFFECTS_ARE_BEHAVIOR` | test / CI | generated CFn shape |
| `make check-synth` | `PRINCIPLE_PHYSICAL_EFFECTS_ARE_BEHAVIOR` | local / CI | synth and IAM description constraints |
| dependency lifecycle audit | `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY` | CI | install-script attack surface drift |
| duplication baseline ratchet | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | CI | unexamined copy-paste growth |
| problem catalog validation | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | CI | schema and bilingual README contract |
| submodule pin guard | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | CI | catalog checkout and recorded pin consistency |
| `/change` approach registry | `PRINCIPLE_INDEPENDENT_SEARCH_BEFORE_CONVERGENCE` | framing / design | independent families、evidence、exact gap、retry condition |
| `/change` async consistency audit | `PRINCIPLE_EVENTUAL_CONSISTENCY_IS_EXPLICIT` | design / completion | duplicate、ordering、retry、timeout、reconciliation |
| `/blindspot-pass` | `PRINCIPLE_ADVERSARIAL_AUDIT` | design / review | semantic unknown-unknowns |
| `/security-review` | `PRINCIPLE_ADVERSARIAL_AUDIT` | pre-PR | auth、data、dependency、trust review |
| `/simplify` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | pre-PR | duplication、complexity、unnecessary concepts |

## Hooks

Hook は repository state の正本ではなく、tool event に対する即時 guard です。

- `guard-config.sh`: 設定 file の安易な編集を事前に止める。
- `post-format.sh`: edit 後に formatter を適用する。
- `quality-guard.sh`: silent fallback や UI layer の direct fetch を edit 後に止める。
- PreToolUse (`git commit`, `.claude/settings.json`): Claude Code が `git commit` を含む Bash command を実行しようとした瞬間に `make before-commit` を先取り実行する。
- Stop hook: browser-observable change に preview verification が必要な可能性を通知する。

commit の最終 gate は `.husky/pre-commit` と CI を正本とします。上記の `git commit` PreToolUse hook は `.husky/pre-commit` と同じ `make before-commit` を呼び出しており、これは意図しない重複ではなく **意図的な defense-in-depth** です。PreToolUse hook は Claude Code が commit コマンドを発行するより前に働く最速の guard で、失敗を早く agent へ返せます。一方 `.husky/pre-commit` は Claude Code 以外の経路 (人間の `git commit`、他の agent、他ツール) でも同じ gate を確実に通す最終防衛線です。片方が無効化・迂回されてももう片方が残るため、二重実行はコストではなく設計です。Claude Code の PreToolUse hook から存在しない script を実行しないことは `hook-command-target-exists` が機械強制します。

## Process invariants

次は意味論的な契約です。単独の regex rule だけでは十分に判定できません。

- `INVARIANT_CONTROL_PLANE_USES_SBT`。
- `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`。
- `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER`。
- `INVARIANT_APP_CODE_IS_UNMODIFIED`。
- `INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`。
- `INVARIANT_PR_SHIPS_WORKING_INCREMENT`。
- `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE`。
- `INVARIANT_PR_REGRESSION_ANALYSIS_DOCUMENTED`。
- `INVARIANT_PR_PHYSICAL_IMPACT_DOCUMENTED`。
- `ONE_PASS_LOCAL`。
- `ONE_PASS_AWS`。

これらは Principle Registry、ADR、PR body、review、実行証拠で監査します。機械化できる部分が見つかった場合は、小さな enforcement rule と test を追加します。

## 例外手続き

違反時の第一手は code の修正です。config、baseline、rule の緩和で隠しません。

正当な例外が必要な場合は、次を行います。

1. rule の誤検知ではなく設計例外である証拠を示す。
2. trust boundary、影響範囲、代替防御を記録する。
3. self-contained な ADR で supersede または scope を限定する。
4. implementation、test、manifest、本レジストリ、関連 Skill を同じ PR で更新する。
