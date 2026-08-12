---
name: change
description: TenkaCloud の複雑な機能追加、障害修正、アーキテクチャ変更を、問題の形式化、独立した approach family の探索、証拠と exact gap の管理、TenkaCloud 固有の敵対的監査、TDD 実装、完了監査の順で進める適応型オーケストレーションスキル。Control Plane、Application Plane、problem runtime、認証、cross-account trust、データ整合性、CFn 物理変更、running cost、複数 mode にまたがる変更で使う。固定人数・固定役割ではなく、課題のリスクに応じて探索観点を動的に選ぶ。
argument-hint: "[変更または問題の概要]"
---

# TenkaCloud Adaptive Change Orchestrator

この Skill は agent へ役職を固定配置するためのものではない。

目的は、異なる approach family を独立に探索し、証拠の弱い案を捨て、TenkaCloud 固有の trust boundary、physical impact、cost、mode parity を敵対的に監査した案だけを working increment として実装することである。

判断原則は [`docs/architecture/principles.md`](../../../docs/architecture/principles.md)、機械強制は [`docs/architecture/enforcement-registry.md`](../../../docs/architecture/enforcement-registry.md) を正本とする。

## 0. 適用判断

単一 agent でよい変更:

- 正解と変更位置が明確な小さな修正。
- 既存 pattern をそのまま適用できる変更。
- 機械的な rename、文書修正、dependency pin 更新。

この Skill で独立探索する変更:

- 複数 plane、mode、workspace をまたぐ。
- auth、tenant isolation、cross-account AssumeRole、永続化を含む。
- EventBridge、CodePipeline、CloudFormation の非同期状態を含む。
- CFn replacement、retention、standing cost が変わり得る。
- 原因仮説または妥当な設計案が複数ある。
- local、Lite、SaaS の parity を判断する必要がある。

単純な変更を無理に multi-agent 化しない。複雑な変更を一つの確信だけで進めない。

## 1. Framing

リポジトリを調査し、作業中の plan に次を記録する。永続 file は作らない。

- user outcome。
- 観測可能な acceptance criteria。
- non-goals。
- affected planes と modes。
- data flow と ownership。
- trust boundaries。
- physical impact の候補。
- standing cost と event-time cost の候補。
- live AWS verification の要否。
- rollback、cleanup、migration の制約。
- 必要な証拠。

既存 code、test、git history、related issue で解決できる曖昧さは先に調査する。

ユーザーへ確認するのは、production deploy、destroy、secret、不可逆な data migration、公開 API、費用、外部副作用の選択が必要な場合に限る。

## 2. Approach Registry

作業中の plan に `Approach Registry` を作る。各 approach は最低限次を持つ。

```text
id:
family:
hypothesis:
expectedEvidence:
evidence:
exactGap:
status: unexplored | active | promising | blocked | disproved | selected
blockedReason:
retryCondition:
adversarialFindings:
```

`blocked` には exact gap、blocked reason、retry condition を必須とする。新しい mechanism や evidence がないまま同じ route を再実行しない。

元の問題を同程度に難しい helper、TODO、将来対応、未証明の整合性へ移しただけの案は `blocked` とする。

## 3. 独立探索

課題に関連する family を動的に選ぶ。人数と役割を固定しない。

候補 family:

- 既存 pattern 再利用と最小差分。
- Control Plane / Application Plane responsibility。
- problem deployment / participant runtime。
- auth / tenant isolation / ExternalId / trust policy。
- DynamoDB / Turso repository boundary と data migration。
- EventBridge duplicate、ordering、retry、reconciliation。
- CloudFormation CREATE / UPDATE / REPLACE / DELETE / retention。
- Lite / SaaS / local play parity。
- participant UX / operator UX / accessibility。
- running cost / cleanup / retained resource。
- backward compatibility / external problem pack contract。
- test / synth / live verification strategy。

初期探索 agent には framing、acceptance criteria、non-goals、制約を共有するが、現在の有力案を大部分へ教えない。

各 agent には status report ではなく、次のいずれかを返させる。

- code location と具体的な変更案。
- failing test または reproduction。
- CFn shape と physical impact。
- data flow と責務境界。
- threat scenario と反例。
- cost resource と課金単位。
- exact gap と次に必要な証拠。

同じ family が増えた場合は未探索領域へ再配分する。

## 4. 選択前比較

候補案を次で比較する。

- acceptance criteria を直接満たす。
- control / application / runtime の責務を漏らさない。
- tenant と AWS account の boundary が明確である。
- retry、duplicate、partial failure を処理できる。
- CFn replacement、retention、cleanup を説明できる。
- standing cost を増やす場合に理由と上限がある。
- supported mode と未対応 mode が明確である。
- CDK assertion、unit test、local play、live verification で証明できる。
- 変更面積と概念数が必要最小限である。

生き残った案だけを `selected` にする。

## 5. Adversarial audit

候補案の生成者とは別の agent に `.claude/agents/tenkacloud-adversarial-auditor.md` の契約で監査させる。

最低限、関連する次の観点を攻撃する。

- tenant escape、resource ownership 欠落。
- auth bypass、認証と認可の混同。
- ExternalId 欠落、trust policy 拡張、IAM wildcard の一般化。
- cross-plane responsibility leak。
- duplicate event、ordering、retry、timeout、partial success。
- CloudFormation replacement、retained table、cleanup 漏れ。
- hidden standing cost、Free Tier 前提の誤り。
- local-only success、SaaS-only assumption、mode drift。
- old data / new code、old client / new API。
- silent fallback、mock、stub、偽の成功。
- rollback、re-run、operator recovery、observability。

error finding が未解決の案は選択または完了しない。

## 6. TDD implementation

1. acceptance criteria と失敗条件を表す test を先に追加する。
2. selected approach を working increment として実装する。
3. CDK change は `Template.fromStack` assertion と `make check-synth` で CFn shape を確認する。
4. code、test、安定した利用者向け docs、runtime config、migration を必要な範囲で同じ PR に含める。
5. scope 外の発見は別 issue / follow-up に切る。
6. duplication、naming、責務を `/simplify` で確認する。

## 7. Completion audit

完了前に次を確認する。

- acceptance criteria ごとに evidence がある。
- selected approach の `exactGap` がない。
- adversarial audit の error が解消している。
- `make harness` が green。
- `make before-commit` が green。
- 必要なら `make check-synth`、`make ci-local` が green。
- `/review`、`/security-review`、`/simplify` を通した。
- `## Regression analysis` がある。
- `## Physical impact` に CREATE / UPDATE / REPLACE / DELETE / NO-OP がある。
- live AWS verification 未実行なら、理由、対象、確認手順を明示した。
- known follow-up と未対応 mode を明示した。

CI green は必要条件であり、acceptance、audit、physical impact、remaining gap の代わりではない。

## 禁止

- 常に同じ人数、同じ役割を起動する。
- 全 agent へ最初から有力案を教える。
- 同じ family の言い換えを多様性として数える。
- status report や楽観論を evidence にする。
- blocked route を新しい mechanism なしに繰り返す。
- competitor account の `AdministratorAccess` 例外を他 role へ一般化する。
- CFn replacement と cost を code review の外へ追い出す。
- 一つの mode の成功を全 mode の成功として報告する。
- gate failure を config、baseline、rule 緩和で隠す。
