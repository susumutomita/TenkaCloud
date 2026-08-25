# ADR-0001: Security drill harness — trust boundary、独立検証の定義、責務境界

- **Status**: Accepted (Phase 0 のみ。Phase 2 以降の autonomous Finder / hosted mode は別 ADR 対象)
- **Date**: 2026-08-25
- **Deciders**: Susumu Tomita (`@susumutomita`)
- **Tracked by**: [Issue #3036](https://github.com/susumutomita/TenkaCloud/issues/3036)

## Context

Issue #3036 は、TenkaCloud の security drill の完了条件を「参加者が修正したと申告した」「静的
スキャナが警告しなくなった」から、「独立した Verifier が生成した実行証拠だけで判定する」へ引き
上げる。これは `docs/architecture/README.md` が言う「standalone design-decision document は残さ
ない」方針の例外です。理由は次の 2 点にあります。

1. この基盤は **採点契約** であり、実装が先行すると「独立検証」「baseline」「fresh re-attack」
   といった言葉の意味が実装ごとに揺れる。TenkaCloud / TenkaCloudChallenge / TenkaCloudSimulator
   の 3 repository が同じ契約を実装するため、境界を先に文書で固定しないと repository 間で意味が
   分岐する。
2. trust boundary の誤りは、tenant isolation や IAM least privilege と同種の高リスク領域であり、
   `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY` が要求する明示化の対象である。

参考実装 [`anthropics/defending-code-reference-harness`](https://github.com/anthropics/defending-code-reference-harness)
(Apache-2.0) の重要な性質 — Recon による attack surface 分割、Finder は PoC のみを提出する、
Verifier は fresh sandbox で PoC を反証する、Finder の reasoning を Verifier へ渡さない、
deterministic orchestrator と untrusted execution plane の分離、sandbox 欠如時の fail closed —
は本 ADR の trust boundary にそのまま取り込む。**契約と設計原則だけを取り込み、コードやリポジト
リそのものは vendor fork / submodule にしない**(Non-goals 参照)。

## Decision

### 1. この基盤が保証すること (Bounded claim)

> 指定した `targetDigest` の脆弱性が独立 Verifier によって fresh environment で再現され、
> `patchDigest` の適用後は同じ witness (schema 検証済み、digest 束縛済み) が同じ fresh
> environment で成立せず、宣言済み正常機能 (golden tests) が保持され、かつ指定 focus area /
> budget 内での fresh re-attack が新しい witness を確認しなかったことを、machine-verifiable な
> 証拠で示す。

保証は **常に**「指定 detector / focus area / budget / target digest の範囲」に限定される。

### 2. この基盤が保証しないこと (Non-goals として明示)

- fresh re-attack の成功 (`no-witness-found`) は「その対象に脆弱性が 1 つも存在しない証明」では
  ない。budget と focus area の範囲を超えた bypass の不在は主張しない。
- LLM の自然言語による説明・自己評価・severity 推定は、`confirmed` / `verified-fixed` / `secure`
  のいずれの判定根拠にもならない。判定は独立 Verifier が生成した実行証拠だけから決定論的に計算
  する (`evaluateFindingVerdict` / `evaluatePatchVerdict`)。
- Phase 1 (本 PR) は participant-triggered attack card でも hosted multi-team execution でもな
  い。TenkaCloud 管理外の target への任意 scan/attack は対象外。
- 本 PR の in-process fixture target ( `packages/security-harness/src/fixtures/*` ) は、
  container isolation・gVisor・egress deny-by-default・resource limit を一切実装しない。これらは
  Simulator 側の execution-plane 責務であり、Phase 1 はその手前の **決定論的な契約検証** に限定
  する (§5 参照)。

### 3. Trust boundary

Issue 本文の 3 分割をそのまま採用し、本 repository (`TenkaCloud`) が実装する範囲を明示する。

| Boundary | 責務 | 本 PR (Phase 0/1) での実装 |
| --- | --- | --- |
| Trusted orchestrator | state machine、budget、policy、artifact digest、container lifecycle を管理し、target code や model 選択コマンドを host 上で実行しない | `packages/security-harness/src/run-state-machine.ts` (状態遷移のみ、副作用なし)、`src/phase1-slice.ts` (呼び出し順序の制御。実行そのものは fixture という隔離済み in-process 実装に委譲) |
| Untrusted execution plane | Finder / Verifier / target / participant patch を隔離環境で実行し、host filesystem・Docker socket・SSH agent・cloud credential・`.env`・home directory を見せない | Phase 1 では **実装しない**。in-process HTTP fixture はホスト権限を一切要求しない自己完結コードであり、real container isolation の代替を主張しない。real isolation は Simulator 側の child Issue に委譲する |
| Evidence boundary | content-addressed artifact、size/type/count limit、パス traversal 拒否、canonical serialization、producer/verifier/policy version の記録、secret redaction | `src/digest.ts` (SHA-256 content addressing)、`src/witness.ts` / `src/validators.ts` (strict schema、未知 field 拒否、size bound、パス traversal 拒否) |

Phase 1 は「Trusted orchestrator と Evidence boundary の契約」を実際に動く形で検証する。
「Untrusted execution plane」の実装 (real container、gVisor、network policy) は意図的に scope
外とし、Known incomplete work として PR に明記する。

### 4. 「独立検証した」と言える条件 (Independent verification の定義)

`FindingEvidence.verdict` が `confirmed` になるのは、次を **すべて** 満たす場合のみ
(`evaluateFindingVerdict` が唯一の正本)。

1. `targetDigest` / `threatModelDigest` が実際に build/起動した artifact と一致する
   (tampered/stale digest は `rejected`)。
2. verifier の sandbox / process が正常終了した (`sandboxFailure=false`)。
3. Finder の workspace を再利用していない (`freshEnvironment=true`)。
4. 少なくとも 1 回の reproduction attempt が行われた。
5. `minimumReproductions` 回以上、独立に再現した。

1 回も再現しなかった場合は `rejected`、部分再現 (flaky) は `inconclusive` とし、
どちらも `confirmed` にはしない。sandbox failure・timeout・model failure は必ず
`inconclusive` に落ち、`confirmed` へのフォールバックはコード上存在しない
(`evaluate-finding.test.ts` が全分岐を固定する)。

`PatchEvaluation.verdict` が `verified-fixed` になるのは、Issue 本文の 7 条件を
`evaluatePatchVerdict` が単一の関数として実装し、次の順序で評価する。

1. digest binding (`digestsMatch`) — 不一致は常に `inconclusive`。
2. baseline finding が `confirmed` であること — でなければ `inconclusive`
   (Baseline first: 未確認の脆弱性に対する「修正」は採点しない)。
3. forbidden side effect (sandbox/policy violation) が無いこと。
4. patch build が成功していること。
5. golden behavior tests — 失敗は `regressed` (endpoint 停止、auth 破壊などの偽修正はここで `regressed` になり、`verified-fixed` にはならない)。
6. original witness replay が `blocked` であること — `landed` は `still-vulnerable`。
7. fresh re-attack (元 witness と異なる identity/object を使う別 witness) が
   `no-witness-found` であること — `witness-confirmed` は `still-vulnerable`
   (id だけを denylist する不完全 patch はここで捕まる)。

すべて通過して初めて `verified-fixed`。途中の `inconclusive` は握りつぶさず、そのまま
`PatchEvaluation.verdict` に反映する。

### 5. Repository responsibility (Issue 本文の分担を ADR として確定)

- **TenkaCloud** (本 repository): versioned schema/contract、`SecurityRun` state machine、
  finding/patch verdict engine、evidence の digest binding。Phase 1 は `packages/security-harness`
  package として実装し、CDK / AWS SDK / model provider に依存しない。
- **TenkaCloudSimulator**: real container を使う execution plane、team-scoped isolation、
  resource limit/kill/cleanup。Phase 1 では未着手 — child Issue で扱う。
- **TenkaCloudChallenge**: 公式の intentionally-vulnerable target、hidden witness fixture、
  spoiler boundary。Phase 1 の fixture target (`packages/security-harness/src/fixtures/*`) は
  **これを代替しない** — 本 package 自身の契約を検証するためだけの使い捨て fixture であり、
  参加者向け catalog problem ではない。

この分担は Issue #3036 本文の "Repository responsibility" をそのまま確定させたものであり、
`#2911` (Agent-only GameDay)、`#1874` (Battle Event Engine)、`#2731` (contributor agent
harness)、`#2422` (`scoring.attackProbes`) のいずれの責務とも重複しない。既存の
`scoring.attackProbes` (`landed | blocked | skipped`) は変更せず、本契約は将来
`PatchEvaluation` からの投影として追加されるだけで置き換えない。

### 6. Threat model (Phase 0 確定)

| Threat | 対応する boundary | Phase 1 での状態 |
| --- | --- | --- |
| Prompt injection (target/witness 内の指示文字列) | Evidence boundary: witness は strict schema でしか解釈されず、自由文字列は実行されない | 実装済み。Phase 1 に LLM は無いため attack surface 自体が存在しない |
| Malicious target (build/start コマンドが任意 shell を実行) | Trusted orchestrator: `CommandContract.operationId` は自由文字列ではなくレビュー済み operation id | `validateSecurityHarnessDefinition` が `operationId` の非空文字列以外を拒否する形で契約のみ固定。実際の operation dispatch (allowlist 実行) は Simulator 側の execution plane 実装まで持ち越し |
| Malicious patch (sandbox escape、他 team への到達) | Untrusted execution plane | Phase 1 は host 権限を持たない in-process fixture のみなので escape surface が存在しない。real isolation は Known incomplete work |
| Fake evidence (digest 詐称、witness 改ざん) | Evidence boundary: digest binding、strict schema | 実装済み・テスト済み (`evaluate-finding.test.ts` / `evaluate-patch.test.ts` の digest mismatch ケース) |
| Secret exfiltration (Authorization header 等の永続化) | Evidence boundary: secret redaction | Phase 1 の witness/finding は固定トークン文字列 (`token-a`/`token-b`) のみを扱い、実 credential を保存しない。実 redaction pipeline は Phase 2 の evidence store 実装まで持ち越し |
| Cross-team access | Trusted orchestrator: run/team 単位の namespace 分離 | Phase 1 は single-team・single-run のみを実装。multi-tenant namespace は Phase 4 (hosted mode) の scope |
| Resource exhaustion (CPU/memory/wall time/tool call) | Trusted orchestrator: budget enforcement | `SecurityHarnessDefinition.budget` の型と validator のみ固定。実際の hard limit 強制は execution plane 実装まで持ち越し |

### 7. Apache-2.0 attribution policy

`anthropics/defending-code-reference-harness` から **コードは一切コピーしていない** —
`packages/security-harness` は独自実装であり、契約 (state machine 名称、witness-only handoff、
fresh verification などの設計原則) だけを参考にしている。したがって本 PR は attribution 表記の
対象外です。

将来のフェーズで同 repository のコードやドキュメント文言を実際に移植する場合は、次を移植先
ファイルの先頭コメントに記載することを本 ADR で義務付ける。

- 元ファイルの Apache-2.0 ライセンス表記へのリンク。
- 元著作権表示 (Anthropic, PBC)。
- 変更した内容の要約 (Apache-2.0 §4(b) の "stating that You changed the files" 要件)。

### 8. 名称・配置の確定

- Package: `packages/security-harness` (`@tenkacloud/security-harness`)。他の dependency-light
  package (`@tenkacloud/format`, `@tenkacloud/problem-sdk` 等) と同じ規約 — CDK/AWS
  SDK/browser 非依存、`vitest`、`tsc --noEmit` の typecheck のみ。
- ADR 配置: `docs/architecture/decisions/000N-*.md`。`docs/architecture/README.md` に本 ADR への
  参照と、これが例外である理由の 1 行注記を追加する。

## Consequences

- **Good**:「独立検証」「baseline」「fresh re-attack」「verified-fixed」の意味が、prose ではなく
  3 つの純粋関数 (`evaluateFindingVerdict` / `evaluatePatchVerdict` / `transitionSecurityRun`)
  として repository-verifiable に固定された。Challenge / Simulator の child Issue は、この契約に
  対して実装を差し込むだけでよく、意味の再交渉が不要になる。
- **Bad**: Phase 1 の fixture target は in-process HTTP であり、Issue が要求する real container
  isolation (gVisor 等) や sandbox 破り耐性は本 PR では未検証。「実際に動く」ことと「安全に隔離
  されている」ことは別の主張であり、後者は Simulator 側の execution-plane 実装と conformance
  test を待つ必要がある。
- **Tradeoff**: Phase 2 (autonomous Finder/Recon) は model provider adapter と Recon 分割ロジック
  を追加するが、本 ADR の state machine (`RECONNING` / `FINDING` 状態) と finding evidence 契約は
  変更せず拡張するだけで済むよう Phase 1 側で先に宣言済み。Phase 3/4 (patch UX、hosted mode) は
  別 ADR / 別 Issue が必要になった時点で追加する。

## References

- Issue: [#3036](https://github.com/susumutomita/TenkaCloud/issues/3036)
- 実装: `packages/security-harness/src/*`
- 原則: `docs/architecture/principles.md` (`PRINCIPLE_EXPLICIT_TRUST_BOUNDARY`, `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE`, `PRINCIPLE_FAIL_LOUDLY_AT_BOUNDARIES`, `PRINCIPLE_COMPLETION_REQUIRES_AUDIT`)
- 作業契約: `AGENTS.md`
- 参考実装 (vendor しない、契約のみ参照): [`anthropics/defending-code-reference-harness`](https://github.com/anthropics/defending-code-reference-harness) (Apache-2.0)
