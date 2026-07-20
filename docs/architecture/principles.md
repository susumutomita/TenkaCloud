# TenkaCloud Agent Principle Registry

この文書は、TenkaCloud を変更する AI エージェントが、未知の状況で判断するときに使う原則の正本です。

機械判定可能な制約は原則として文章だけへ置かず、[Enforcement Registry](./enforcement-registry.md) に登録し、harness、quality gate、linter、test、CI、hook で強制します。

## 運用

- 原則には安定した `PRINCIPLE_*` ID を付ける。
- 原則は状況に応じた比較と証拠評価へ使う。
- 同じ入力に対して真偽を決定論的に判定できる要求は machine rule にする。
- 原則や例外の変更は self-contained な ADR で理由、影響、移行を記録する。
- 一般原則の例外は trust boundary と代替防御を明示し、他の領域へ一般化しない。

## Principles

### `PRINCIPLE_EVIDENCE_OVER_CONFIDENCE`

「動くはず」ではなく、test、typecheck、CDK assertion、synth、CFn diff、local play、再現手順、実デプロイ結果を証拠にする。

CI が実 AWS へ deploy しない経路では、未検証であることを隠さず、PR body に one-time live verification の必要性と影響範囲を書く。

### `PRINCIPLE_INDEPENDENT_SEARCH_BEFORE_CONVERGENCE`

複雑な設計、障害、セキュリティ問題では、有力案へ全エージェントを早期収束させない。

control plane、application plane、problem runtime、data consistency、auth、cross-account trust、participant UX、operator UX、cost、cleanup など異なる approach family を独立に探索する。同じ family が増えた場合は未探索領域へ再配分する。

### `PRINCIPLE_ADVERSARIAL_AUDIT`

候補案は生成者とは別の視点から壊す。

少なくとも、tenant escape、auth bypass、cross-plane responsibility leak、hidden standing cost、CloudFormation replacement、eventual consistency、duplicate event、retry、rollback、cleanup、backward compatibility、silent fallback のうち関連する観点を監査する。

### `PRINCIPLE_ONE_PASS_PRODUCT_SLICE`

完成単位は、利用者が観測できる一気通貫の product slice とする。

必要な範囲で data、API、UI、problem deployment、participant experience、operator recovery、test を接続する。scaffolding、未接続 UI、API だけ、CDK resource だけを完了と呼ばない。

### `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY`

認証、認可、tenant、AWS account、cross-account AssumeRole の境界を明示する。

一般の IAM policy は least privilege をデフォルトとする。ただし `infrastructure/templates/competitor-bootstrap.yaml` の competitor account role は、問題 template が作成する AWS resource の種類が事前に固定できないため、意図的に `AdministratorAccess` を使う例外である。

この例外は次の代替防御と一体で扱う。

- trust policy を TenkaCloud account ID へ限定する。
- `ExternalId` を必須とする。
- セッション duration を制限する。
- competitor が stack 削除で一括 revoke できる。
- 競技用または隔離された account を前提とする。

この例外を Control Plane、Application Plane、CI、運用者 role へ一般化してはならない。

### `PRINCIPLE_PHYSICAL_EFFECTS_ARE_BEHAVIOR`

IaC の物理変更と running cost を機能仕様の一部として扱う。

CREATE、UPDATE、REPLACE、DELETE、retention、standing cost、cleanup、rollback を PR の regression analysis と physical impact に含める。コード上の rename や property change が resource replacement になる可能性を無視しない。

### `PRINCIPLE_EVENTUAL_CONSISTENCY_IS_EXPLICIT`

EventBridge、CodePipeline、CloudFormation、cross-account operation の非同期性を正常系の一部として設計する。

重複、順序違い、retry、timeout、部分成功、遅延、再起動を前提にし、idempotency、reconciliation、状態遷移、観測方法を明示する。

### `PRINCIPLE_FAIL_LOUDLY_AT_BOUNDARIES`

外部入力、認証、永続化、AWS API、source bundle、problem pack の境界で、不整合を空配列や偽の成功へ変換しない。

運用者が中断、再試行、復旧、通知を判断できる情報を持つ error として返す。mock、stub、silent fallback で障害を隠さない。

### `PRINCIPLE_COST_IS_AN_ARCHITECTURE_CONSTRAINT`

TenkaCloud の個人利用と community event の継続可能性を守るため、standing cost と event-time cost を設計判断に含める。

「Free Tier」という名称ではなく、実際に生成される resource、課金単位、credit 終了後の charge、retained resource を確認する。コスト削減のために isolation、durability、observability を暗黙に弱めない。

### `PRINCIPLE_EXPLICIT_GAPS`

未検証の仮定、live verification、migration gap、未対応 mode、blocked reason、retry condition を具体的に記録する。

SaaS、Lite、Always-On、local play の1つだけで成功した結果を、他 mode でも検証済みであるかのように扱わない。

### `PRINCIPLE_COMPLETION_REQUIRES_AUDIT`

実装終了とタスク完了を分ける。

受け入れ条件、adversarial audit、machine gate、regression analysis、physical impact、live verification gap、known follow-up を確認してから完了とする。green CI は必要条件であり、意味論的な完了の十分条件ではない。

## Principle と enforcement の境界

次をすべて満たす要求は machine enforcement へ置く。

1. 同じ repository state に対して同じ真偽を返せる。
2. 誤検知と見逃しを許容範囲に抑えられる。
3. staged check、edit hook、test、CI のいずれかで自動的に止める価値がある。

責務境界の妥当性、脅威モデル、移行戦略、UX、コストとの trade-off など、文脈に応じた証拠比較が必要なものは principle、ADR、review で扱う。
