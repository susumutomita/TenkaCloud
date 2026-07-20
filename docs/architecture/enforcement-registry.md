# TenkaCloud Enforcement Registry

この文書は、AI エージェントの遵守に委ねず、機械的に強制する rule と gate の索引です。

判断原則は [Principle Registry](./principles.md) を正本とする。

## 登録要件

新しい禁止や必須条件を追加するときは、最初に機械判定可能かを判断する。可能な場合は散文だけへ追加せず、次を同じ PR に含める。

- rule ID。
- 対応する principle ID。
- implementation path。
- execution timing。
- scope と severity。
- 正常、違反、境界、誤検知防止の test。
- 正当な例外の手続き。

## Architecture harness

| Rule ID | Principle | Scope | Severity |
| --- | --- | --- | --- |
| `secrets-manager-forbidden` | `PRINCIPLE_COST_IS_AN_ARCHITECTURE_CONSTRAINT` | AWS SDK import | error |
| `handler-must-not-call-fetch` | `PRINCIPLE_FAIL_LOUDLY_AT_BOUNDARIES` | handler | error |
| `handler-no-direct-sdk-import` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | Lambda entrypoint | error |
| `handler-tenant-isolation` | `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY` | tenant-scoped DDB handler | error |
| `iam-wildcard-needs-justify` | `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY` | IAM policy | error |
| `lambda-env-size` | `PRINCIPLE_PHYSICAL_EFFECTS_ARE_BEHAVIOR` | synthesized Lambda environment | warning / error |
| `domain-no-infra-import` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | control-data domain | error |
| `runtime-composition-root-only` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | control-data runtime composition | error |
| `file-too-large` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | application / infrastructure source | warning / error |
| `adr-must-be-html` | `PRINCIPLE_EXPLICIT_GAPS` | architecture decision records | error |
| `adr-self-contained` | `PRINCIPLE_EXPLICIT_GAPS` | architecture decision records | error |
| `no-conflict-markers` | `PRINCIPLE_COMPLETION_REQUIRES_AUDIT` | repository text | error |
| `no-aws-trademark-fictions` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | public content | error |

`handler-tenant-isolation` は tenant logic を handler から禁止する rule ではない。tenant-scoped handler が DDB command を発行するとき、同一 file で `tenantId` を参照することを要求し、partition key や condition への tenant boundary の入れ忘れを検知する guard である。

## Quality gates

| Gate | Principle | Timing | Purpose |
| --- | --- | --- | --- |
| Biome | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | edit / pre-commit / CI | syntax、format、unsafe construct |
| textlint / markdownlint | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | pre-commit / CI | public documentation quality |
| Vitest | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | local / CI | behavior and regression |
| coverage gate | `PRINCIPLE_COMPLETION_REQUIRES_AUDIT` | CI | agent-owned workspace coverage |
| CDK `Template.fromStack` | `PRINCIPLE_PHYSICAL_EFFECTS_ARE_BEHAVIOR` | test / CI | generated CFn shape |
| `make check-synth` | `PRINCIPLE_PHYSICAL_EFFECTS_ARE_BEHAVIOR` | local / CI | synth and IAM description constraints |
| dependency lifecycle audit | `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY` | CI | install-script attack surface drift |
| duplication baseline ratchet | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | CI | unexamined copy-paste growth |
| problem catalog validation | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | CI | schema and bilingual README contract |
| submodule pin guard | `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE` | CI | catalog checkout and recorded pin consistency |
| `/blindspot-pass` | `PRINCIPLE_ADVERSARIAL_AUDIT` | design / review | semantic unknown-unknowns |
| `/security-review` | `PRINCIPLE_ADVERSARIAL_AUDIT` | pre-PR | auth, data, dependency, trust review |
| `/simplify` | `PRINCIPLE_ONE_PASS_PRODUCT_SLICE` | pre-PR | duplication, complexity, unnecessary concepts |

## Hooks

Hook は repository state の正本ではなく、tool event に対する即時 guard である。

- `guard-config.sh`: 設定 file の安易な変更を実行前に止める。
- `post-format.sh`: edit 後に formatter を適用する。
- `quality-guard.sh`: silent fallback、UI layer direct fetch など局所的な危険パターンを edit 後に止める。
- Stop hook: browser-observable change に preview verification が必要な可能性を通知する。

commit の最終 gate は `.husky/pre-commit` と CI を正本とする。Claude Code の PreToolUse hook から、存在しない script や別系統の gate を重複実行しない。

## Process invariants

次は意味論的な契約であり、単独の regex rule だけでは十分に判定できない。

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

これらは Principle Registry、ADR、PR body、review、実行証拠で監査する。機械化できる部分が見つかった場合は、小さな enforcement rule と test を追加する。

## 例外手続き

違反時の第一手は code の修正である。config、baseline、rule の緩和で隠さない。

正当な例外が必要な場合は、次を行う。

1. rule の誤検知ではなく設計例外である証拠を示す。
2. trust boundary、影響範囲、代替防御を記録する。
3. self-contained な ADR で supersede または scope を限定する。
4. implementation、test、本レジストリ、関連 Skill を同じ PR で更新する。
