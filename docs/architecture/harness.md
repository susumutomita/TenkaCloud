# TenkaCloud Architecture Harness

この文書は、セッションが変わっても壊してはいけない原則を機械可読な ID つきで固定する正本です。

## Invariants

- `INVARIANT_CONTROL_PLANE_USES_SBT`
  Control Plane は `@cdklabs/sbt-aws` の ControlPlane construct に乗せる。Cognito User Pool / API Gateway / EventBridge を自前で再実装しない。sbt-aws の更新に追従する。

- `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`
  Control Plane は tenant manager であり、tenant runtime host ではない。AssumeRole + CloudFormation 経由の問題 deploy は tenant Application Plane (`ProblemDeployBackendStack`) 側に閉じ込め、Control Plane stack には持ち込まない。

- `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER`
  テナント分離はインフラ層で実現する。DynamoDB は PK にテナント ID を含める。アプリコードでは tenant 識別ロジックを書かない（アプリは自分が誰のためのインスタンスか知らなくていい）。

- `INVARIANT_APP_CODE_IS_UNMODIFIED`
  `apps/` 配下のアプリケーションコードは tenant ごとにフォークしたり書き換えない。同じ build artifact (`dist/`) を pooled stack と silo stack の両方で使い回し、tenant 差分は CDK が `runtime-config.json` 経由で注入する。tenant ごとに変わる可能性があるのは config だけで、コードは 1 セット。これが崩れた瞬間に「customer 1 = fork 1」になり SaaS の経済が壊れる。

- `INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`
  認証 (Cognito UserPool / Hosted UI / JWT) はインフラ層で注入する。アプリコードに認証バイパス (`AUTH_SKIP` 的な分岐) や tenant 識別ロジックを書かない。production / dev で別のフロー要件が出ても、CDK 側で UserPool を分けるか callback URL を切り替えるかで対応する。アプリ側の `if (isDev)` でのバイパス禁止。

## One Pass

セッションが変わっても、次の 2 つのフローを 1 回で通せる状態を保つ。

- `ONE_PASS_LOCAL`
  ローカル開発で `make install` → 各 SPA の `make dev` を起動した後、`apps/admin-console` から `apps/application-admin-console` へ繋いで「tenant 作成 → application console → 問題 deploy form 表示 → participant portal でログイン」までブラウザ操作だけで一気通貫で動くこと。途中で別ターミナルでスクリプトを叩く / .env を手で書き換える必要が発生したら、その時点で原因を CDK / scripts に戻して恒久化する。

- `ONE_PASS_AWS`
  AWS deploy では `infrastructure/environments/<env>/.env` に必須値だけ入れて `make deploy` 1 発で「Phase 1 (backend) → Phase 2 (admin-console hosting) → Phase 3 (callback 更新)」が通り、SystemAdmin 招待メール → admin-console ログイン → tenant 作成 → application-admin-console から問題 deploy → 競技者 portal でログイン → 問題エンドポイント表示まで一気通貫で動くこと。teardown は `make destroy` で冪等。途中失敗時は同じコマンドで resume できる。

## PR Discipline

商用 SaaS として出す以上、「動くものを小さくインクリメンタルに積み上げる」規律を PR 単位で強制する。ここでいう「動くもの」は商用運用に耐える状態を指す。小さい scope でも、テストされていて、意図が明示されていて、場当たり対応が混ざっていない。デモのためのハリボテ、proof-of-concept、後続 PR が前提の scaffolding は対象外。

参考ケース: `https://zenn.dev/nttdata_tech/articles/8a010aff542625`。AI-native 開発の失敗パターンとして、テスト観点不足・PR 単位の不明瞭・仕様の埋没があり、これらは統合テストまでリグレッション検出を遅らせる。PR 単位でこの視点を強制する。

- `INVARIANT_PR_SHIPS_WORKING_INCREMENT`
  PR 単体を main に merge した後、ユーザー観察可能な機能が 1 つ以上 start working すること。次の 3 条件を同時に満たすこと。
  - 小さい (1 PR = 1 関心事、触るファイル数はおおむね 10 を超えない)
  - 商用品質 (テストされていて意図が明確、場当たり的な hardcode / TODO 残しが無い)
  - 独立に価値を持つ (「別 PR の土台」「scaffolding」「consumer 待ちのライブラリ」は単独では merge しない)

- `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE`
  コード変更と、そのコードの振る舞いを固定するテストを同じ PR に含める。既存テストでカバーされている場合は「この PR で追加したテストはゼロ」と明記してよい。ただし、どの既存テストがどの挙動を守るかを PR body で明示する。AI 生成テストを含める場合、主張する code path を実際に exercise しているか手で確認する。claim と実体の食い違いが起きる場合もある。

- `INVARIANT_PR_REGRESSION_ANALYSIS_DOCUMENTED`
  PR body の `## Regression 分析` セクションで、merge で壊しうる既存挙動を列挙する。確認方法 (grep / code read / test run / 実環境観察) を項目ごとに書く。未確認が 1 つでも残っている PR は DRAFT のまま残す。テストが green であることは Regression 分析の代替にならない。テストが existing behavior をカバーしているか自体の確認が別途必要。

- `INVARIANT_PR_PHYSICAL_IMPACT_DOCUMENTED`
  PR body に `## 物理影響` セクションを置く。そこで `make deploy` で変わる AWS リソース、`make build` で変わる成果物を列挙する。CFT 差分ゼロの場合も明示し、reviewer に推論させない。種別は CREATE / UPDATE / REPLACE / DELETE / NO-OP から選ぶ。

## Banned Assumptions

- アプリコード内で tenant ID を引き回す前提（`INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER` 違反）
- 「一部画面が出た」「synth だけ通る」を one-pass completion と見なす運用
- 「テストが green だから merge OK」思考。Regression 分析を省略する言い訳にしない。テストが existing behavior をカバーしているかどうかは別途確認
- 「small PR だから影響範囲も小さい」という前提 (diff の行数と影響範囲は独立。小さい IAM 変更 1 行で本番が止まる)
- 「動くまでチェイン PR が要る」形の scaffolding PR を単独 merge する運用 (`INVARIANT_PR_SHIPS_WORKING_INCREMENT` 違反)。consumer と束ねて 1 PR にするか、rebase で順序を整える
- 「動くもの = 最小のハリボテでもよい」誤解 (商用品質が条件。小さい scope ≠ 雑でよい)
- AI 生成テストの実効性を人間が検証しない運用。claim している code path を実際に exercise しているか確認しないまま merge する

## Enforcement Rules

Invariants に加えて、実装レベルの原則を機械検査するルールを harness が持つ。ルール ID は `secrets-manager-forbidden` のようにケバブケースで命名する。

- `secrets-manager-forbidden`
  `@aws-sdk/client-secrets-manager` の import を TS/JS ファイルで検出すると error。TenkaCloud はコスト 0 運用を原則とし、秘匿値は SSM Parameter Store (SecureString, Standard tier = 無料) に置く。Secrets Manager はシークレット 1 件あたり月額課金が発生する。

- `handler-must-not-call-fetch`
  `lib/handlers/` 配下のファイルで `fetch(` の直接呼び出しを検出すると error。handler (Controller 層) は入力検証と Service 呼び出しとレスポンス整形のみを担い、外部 API 通信は Repository 層に閉じ込める。Controller に fetch を入れると Service / Repository の境界が崩れ、ユニットテストが HTTP モック前提になる。

- `adr-must-be-html`
  `docs/architecture/adr-*.md` を staged に含めると error。ADR は HTML で書き、row span / color / SVG / collapsible などの表現力を使える形で正本化する。`docs/architecture/harness.md` は invariant の source-of-truth なので対象外。

- `adr-self-contained`
  `docs/architecture/adr-*.html` に chat 文脈、段階的反映 metadata、AI agent との役割分担メモが含まれると error。ADR は OSS readers が単独で読める正本として書く。既存違反は `.claude/harness/baselines/adr-self-contained.json` に baseline 化し、新規 regression だけを捕まえる。

## Enforcement

- `make harness` (= `bun run .claude/harness/bin/architecture.ts --staged --fail-on=error`)
- `make harness-test` (= `cd .claude/harness && bunx vitest run`)
- `make tech-debt` (= `bun run .claude/harness/bin/tech-debt.ts`)
- `make before-commit`（`.claude/settings.json` の PreToolUse hook と `.husky/pre-commit` から自動実行）

## Harness Commands

- Staged ファイルに対する strict run: `make harness`
- Harness ルール自体のユニットテスト: `make harness-test`
- 技術的負債レポート生成: `make tech-debt`
- コミット前チェック: `make before-commit`

Git hook と AI エージェント向けガイドは、この文書を参照して同じ判定に従う。
