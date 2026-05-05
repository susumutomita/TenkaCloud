# Problem Deploy 機能 要件定義

- **Status**: Draft (2026-05-05)
- **Scope**: TenkaCloud の operator が SaaS UI から「問題スタック」を競技者の AWS アカウントへ deploy する機能。本ドキュメントは要件 (= 何を満たせば成功か) を定義する。実装方針 (= どう作るか) は別途 ADR で決める。
- **Related**: ADR-001 (実装案、本要件確定後に書き直す)

## ゴール

operator (TenkaCloud 顧客企業の運営担当) が、自社競技イベント (Battle / Challenge) を **TenkaCloud SaaS の画面操作だけで** 開催 → 運営 → 撤収まで通せる。AWS Console は触らない、コマンドラインは叩かない。

operator が達成したい仕事は次のとおり。

1. **Pre-event**: イベント当日に向けて、参加者全員分の問題環境を「ボタン 1 つで」競技者アカウント側に展開する
2. **During-event**: 各参加者の deploy 状況を画面で把握する。失敗していたら再実行ボタンで取り戻す (operator はデバッグできないので、それ以上の操作は要求しない)
3. **Post-event**: 全環境を「ボタン 1 つで」撤収する

## アクター

| アクター | TenkaCloud から見た位置 | 操作する場所 |
|---|---|---|
| **operator** (運営担当者) | TenkaCloud のテナント (顧客企業) の admin | TenkaCloud SaaS (`application-admin-console`) のみ。AWS Console / CLI は触らない、触れない前提 |
| **participant** (競技者) | 1 チームに 1 名以上 | TenkaCloud SaaS (`participant-portal`) のみ |
| **問題作者** | operator と同一人物のことが多い | TenkaCloud SaaS の問題管理画面 (要 設計) |

## システム境界

| AWS account | 誰の管理下 | 何が動く |
|---|---|---|
| **TenkaCloud 自社 AWS account** | TenkaCloud (= SaaS 提供側) | Control Plane / Application Plane 全部、Step Functions / Lambda / DDB / S3 / Cognito |
| **競技者 AWS account** | competitor (= 競技参加者 or 主催者が用意した使い捨てアカウント) | 問題スタックの CFn 配下のリソースのみ。`competitor-bootstrap.yaml` で IAM Role + ExternalId が事前設定済 |

operator の AWS account は **登場しない**。operator は TenkaCloud SaaS の顧客であり、TenkaCloud の sub-account を持たない。

competitor account は **TenkaCloud の AWS Organizations 配下にあるとは限らない** (野良 AWS account を許す前提)。これは Service Catalog の Org 単位 portfolio 共有が**使えない**という設計制約に直結する。

## Functional Requirements

### FR-1. 規模 (Scale)

| 競技形式 | 1 イベントの典型値 | 1 batch の最大 deploy 数 |
|---|---|---|
| **Battle** | 25 チーム × 1 問 | 25 stacks |
| **Challenge** | 25 チーム × 30 問 | **750 stacks** |

設計はこの規模を **1 batch で起動できる** ことを前提とする。Challenge 規模 (750 stacks) を operator が手作業で 1 つずつ起動することは要件として認めない (= bulk operation が必須)。

### FR-2. CRUD 4 操作すべて要る

| 操作 | 必要 | 主な利用シーン |
|---|---|---|
| **Create** | ✅ 必須 | 新規 deploy。FR-1 規模 (= 25 × 30 = 750 stacks/batch) |
| **Read** | ✅ 必須 | operator が UI で deploy の状況を見られる |
| **Update** | ✅ 必須 | **問題作成 iteration**: test deploy → CFn テンプレを直す → Update で同 stack を新版に切り替える → 動作確認 …のループを問題作者が回す |
| **Delete** | ✅ 必須 | イベント終了時の bulk teardown、または iteration 中の不要 stack 撤去 |

Update のスコープは **問題作成 (authoring) の iteration** が主用途。1 件単位の Update を機敏に回せることが重要 (= bulk 1 batch 内の更新ではなく、1 問題 × 1 test account の小回り Update)。

イベント本番中に既 deploy へ hot-fix を流す運用は想定しないが、Update 機能自体は authoring iteration のために必要なので CRUD は 4 操作すべて持つ。

### FR-3. 失敗時の operator UX

operator はデバッグできない前提。

- 失敗 item は UI に「N 件失敗」とだけ表示
- operator は **「失敗した分だけ再実行」ボタン 1 つで部分 retry** できる
- 再実行は前回の input で再起動するだけ (内部的な詳細を operator に問わない)
- 連続失敗時の代替手段 (チケット起票、サポート問い合わせ) は SaaS の operational support に委ねる (本機能の責務外)

### FR-4. cleanup の保証範囲

operator が「Delete」を押せば、CFn `DeleteStack` が成功するところまでを TenkaCloud が保証する。

それ以外は次のとおり扱う。

- CFn 配下に閉じ込められていない実リソース (CFn 外で API 直叩きで作ったもの等) の漏れは **問題作者の責任**
- 問題テンプレ規約として「`DeletionPolicy: Delete` を全 resource に明示」「CFn の外でリソースを作らない」ことをガイドラインに明記
- TenkaCloud は実リソース漏れ検知・強制削除の機能を持たない

### FR-5. 問題カタログ + authoring iteration

operator (= 問題作者) は **TenkaCloud SaaS UI から問題を作成・更新・削除できる**。

- 問題には CFn テンプレートが紐付く (バージョン管理あり)
- 可視範囲を選べる: `public` / `org-shared` / `private`
- public は全 tenant が deploy 対象として選べる
- org-shared / private のセマンティクスは ADR で詳細化 (`組織` というエンティティの定義含む)

問題のメタデータ (タイトル、説明、可視範囲、template URL 等) は SaaS の DDB で管理。CFn テンプレ実体は S3 上に置く (バージョンごとに別 key、または S3 versioning)。

**Authoring iteration**: 問題作者は次のループを TenkaCloud SaaS UI 上で回せる。

1. 新規問題を作る (テンプレートを upload)
2. 自分の test 用 competitor account に **1 件だけ deploy** (= 単発 Create)
3. 動作確認 (participant-portal や AWS Console から確認)
4. 不具合があればテンプレートを upload し直し (新バージョン)
5. 同じ test stack に **Update** を流す (= 単発 Update)
6. CFn Update が drift / `UPDATE_ROLLBACK_FAILED` 等で詰まったときは **Delete** で test stack を捨てて、ステップ 2 に戻って再作成する
7. OK になったら可視範囲を `public` 等に切り替えて公開

このループを「単発 (1 問題 × 1 account) の小回り CRUD」として扱う。FR-1 の bulk 規模 (750 stacks) とは別経路だが、API・state machine は共通でよい (Map iterator が 1 件回るだけ)。

### FR-6. operator UI workflow

最低限の操作フローは次のとおり。

1. 問題カタログ画面で問題を複数選択
2. 競技者アカウント情報 (account ID + ExternalId + region) を複数選択 (登録済 account から)
3. 「Deploy」ボタン → batch 実行開始
4. batch 進捗画面で N/M 件成功・失敗を見られる
5. 失敗があれば「失敗分を再実行」ボタンが出る
6. イベント終了時、batch 一覧画面から「Delete」ボタンで teardown

competitor account の登録 (account ID + ExternalId + competitor が立てた IAM Role 名) は別 UI が要る。これは別 Issue (#459) で扱う。

## Non-functional Requirements

### NFR-1. operator の AWS 習熟度を期待しない

operator は IAM, CFn, Step Functions, EventBridge を 1 つも触ったことがない人を想定する。SaaS UI の用語も「AssumeRole」「ExternalId」のような AWS 専門語を画面に出さず、「競技者アカウントの接続情報」のような業務用語に翻訳する。

competitor account 側の `competitor-bootstrap.yaml` を participant に流してもらう手順だけは AWS 知識を要するため、これは participant (or その所属組織の AWS 担当) 向けの手順書として別途用意する。

### NFR-2. operator は TenkaCloud の AWS account を一切触らない

これは SaaS の本質。operator が TenkaCloud のリソース (Step Functions の Console 等) を直接見る運用は一切想定しない。失敗時の状態は SaaS UI に翻訳して提示する。

### NFR-3. 競技者アカウントの組織関係を仮定しない

競技者 AWS account は TenkaCloud の AWS Organizations 配下にあるとは限らない (野良 account ありえる)。

これは AWS Service Catalog の **AWS Organizations 単位の portfolio 共有が使えない** ことを意味する。cross-account access は全て **IAM AssumeRole + ExternalId** (`competitor-bootstrap.yaml` で立てた Role) で行う。

### NFR-4. 問題テンプレ規約

問題作成者向けの規約として次の事項を明文化する。

- すべての AWS リソースを CFn 配下に作る (API 直叩きでリソースを作らない)
- `DeletionPolicy` は明示的に `Delete` (デフォルトの場合は省略可、`Retain` を使うときは合理的な理由を README に書く)
- `competitor-bootstrap.yaml` の IAM Role が持つ権限の範囲内で作れるリソースだけを使う

詳細は別ドキュメント (`problems/CONVENTIONS.md` 想定) で展開。

## 暗黙の前提として禁止する事項

要件外として、次の事項は本機能の scope に**含めない**。

- ❌ operator が AWS Console / CLI を直接触ること
- ❌ operator が TenkaCloud の AWS account にアクセスすること
- ❌ AWS Service Catalog の UI を operator に直接見せる構成
- ❌ AWS Organizations 単位での competitor account 共有を前提にする構成
- ❌ 問題テンプレ実体を SaaS DDB に直書き (= S3 に置く前提)
- ❌ イベント本番中に operator が既 deploy へ hot-fix を流す運用 (Update 機能自体は authoring iteration 用に持つが、live-event hot-fix の UX は提供しない)

## Service Catalog 採否の判断基準

ADR で実装案を比較するときの基準を要件側から固定する。

Service Catalog を採用するためには下記すべてを満たす必要がある。

| 条件 | Service Catalog で満たせるか | 結論 |
|---|---|---|
| operator が SaaS UI から問題を upload して即 deploy 可能にできる | △ Service Catalog はもともと admin が portfolio を組む前提。SaaS Lambda が Service Catalog API を叩いて product version を登録する仕組みは作れる | 仕組み次第 |
| 野良 (TenkaCloud Org 外) AWS account へ deploy できる | ❌ Service Catalog の portfolio 共有は AWS Organizations 単位 | **不可** |
| operator に AWS Console を見せない | ❌ Service Catalog の主 UI は AWS Console | **不可** (provisioning engine 専用利用ならいけるが、その場合 UI は SaaS 側で作るので Service Catalog のメリットが薄れる) |

**判断**: NFR-3 (野良 account 許容) の時点で Service Catalog の cross-account 機構が使えない。ADR では Step Functions による自前実装を採用する。Service Catalog は採用しない。

## 受け入れ基準 (Acceptance Criteria)

要件が満たされた状態を operationally に判定するチェックリストを次に示す。

- [ ] `make deploy` を 1 回流して、operator が次のフローを SaaS UI だけで完走できる
  - 詳細手順:
  1. operator がログイン
  2. 25 チーム × 30 問の Challenge セットを選択して Deploy
  3. 進捗画面で全 750 件の状況が見える
  4. 失敗があれば「失敗分を再実行」で部分 retry できる
  5. イベント終了で「Delete」を押せば全 750 stack が CFn DeleteStack 成功する
- [ ] operator は AWS Console / CLI を一度も触らずに完走できる
- [ ] operator は IAM / CFn / Step Functions / Lambda の語を SaaS 画面上で目にしない
- [ ] competitor account を野良 AWS account にしてもフローが通る
- [ ] 750 件 batch が現実的時間内に完了する (上限は ADR で詳細化、SLO 候補: 1 hour 以内)
- [ ] 1 batch 内の 1 件失敗が他 749 件の成功を妨げない
- [ ] CFn DeleteStack が成功するところまでを cleanup 完了とみなす (実リソース漏れは問題作者責任)
- [ ] 問題作者が TenkaCloud SaaS UI 上で次のループを回せる: 新規作成 → 1 件 deploy → テンプレ修正 → Update → 動作確認 → 公開

## Open questions (要件レベルで未確定、ADR 着手前に確定が必要)

1. **`org-shared` の "組織" の定義** — tenant のグループか、tenant 内の team か、ACL 列か (ADR-003 候補)
2. **競技者アカウント登録 UI と ExternalId 管理** — Issue #459 で別途
3. **問題作成者と operator の権限関係** — 同一テナント内で role 分離するか、operator なら誰でも問題を作れるか
4. **batch SLO の具体値** — Acceptance Criteria 記載の「1 hour 以内」は仮置き

## References

- Issue #458 — Deploy 操作の publish 経路 (本要件文書で再整理、現実装案は ADR-001 で書き直し)
- Issue #459 — Cross-account federation (ExternalId 管理) — 本要件の前提
- `infrastructure/templates/competitor-bootstrap.yaml` — 競技者側 IAM Role 定義
- ADR-001 (Draft) — 本要件確定後に Decision を書き直す対象
