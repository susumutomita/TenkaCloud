# The infrastructure workspace also exports a `cdk` bin. Route every command
# through the shared resolver so neither that bin nor a global CLI can win.
CDK      := cd infrastructure && JSII_DEPRECATED=quiet ../scripts/run-cdk.sh
APPROVAL := --require-approval broadening

# SBT 0.3.9 内部が aws-cdk-lib の deprecated な `advancedSecurityMode` 等を使っているため、
# cdk synth 時に大量の deprecation warning が出る。CFT 出力には影響しないので JSII_DEPRECATED=quiet
# で抑制する。SBT upstream が新 API (standardThreatProtectionMode) に移行したら外す。
export JSII_DEPRECATED := quiet

.DEFAULT_GOAL := help
HELP_LANG ?= en
HELP_RENDERER := scripts/ops/make-help.awk

.PHONY: help help-en help-ja install install_ci submodule-latest build typecheck test test-coverage test-scripts audit-deps before-commit ci-local openapi openapi-check release-report release-check \
        lint lint-md lint-text lint-format lint-ts \
        fix fix-md fix-text fix-format format \
        harness harness-test tech-debt dead-code ever-better-diagnose \
        pack-init pack-validate pack-install pack-activate pack-deactivate pack-list \
        form-setup \
        env-check env-check-lite env-init turso-live turso-live-guide turso-live-preflight turso-live-verify-cfn turso-reset \
        deploy deploy-saas destroy destroy-saas \
        deploy-battles destroy-battles \
        deploy-always-on-command destroy-always-on-command synth-always-on-command \
        deploy-always-on-runtime archive-always-on-runtime destroy-always-on-runtime synth-always-on-runtime \
        dev synth check-synth \
        doctor local-onboard local local-up local-portal local-down local-status local-list local-evaluate local-reset local-snapshot-export local-snapshot-import local-disrupt local-measure ensure-deps

# ===== Help | ヘルプ =====
help: ## Show command help (default: English) | コマンド一覧を表示（既定: 英語）
	@awk -v lang="$(HELP_LANG)" -f $(HELP_RENDERER) Makefile

help-en: ## Show command help in English | コマンド一覧を英語で表示
	@$(MAKE) --no-print-directory help HELP_LANG=en

help-ja: ## Show command help in Japanese | コマンド一覧を日本語で表示
	@$(MAKE) --no-print-directory help HELP_LANG=ja

# ===== Setup / Build | セットアップ / ビルド =====
install: ## Install development dependencies safely | 開発依存関係を安全設定でインストール
	# --ignore-scripts: defuse mini-shai-hulud 2nd wave (Flatt Tech, 2026-05-12).
	# bun does not honour npm_config_ignore_scripts or .npmrc's ignore-scripts,
	# so the flag is required on every invocation. Husky's `prepare` is skipped
	# along with everything else, so we re-bootstrap it explicitly afterwards.
	bun install --ignore-scripts
	bun x husky
install_ci: ## Install locked CI dependencies without lifecycle scripts | lockfile固定・script無効でCI依存関係をインストール
	bun install --frozen-lockfile --ignore-scripts
# Manual on-demand bump of the problems/ submodule to its tracked branch tip (.gitmodules branch=main).
# Leaves the bump *staged* for you to review + commit; the scheduled submodule-sync workflow does the
# same automatically as its own PR. Pre-commit only *syncs* the worktree to the pin, it never bumps.
submodule-latest: ## Update and stage the problem catalog submodule | 問題カタログsubmoduleを最新版へ更新してstage
	git submodule update --remote --recursive problems
	@git diff --quiet -- problems \
		&& echo "problems already at the latest pin." \
		|| { git add problems; echo "problems bumped + staged — review the submodule diff, then commit."; }
build: ## Build all applications and infrastructure | 全アプリとinfrastructureをbuild
	bun run build
typecheck: ## Type-check every TypeScript workspace | 全workspaceのTypeScript型検査
	bun run typecheck
test: ## Run tests in every workspace | 全workspaceのテストを実行
	bun run test
# The repo-root tests that live outside every workspace: the landing generators' --check mode and
# the seams under scripts/ (workspace planning, coverage registry, form setup). CI's test surface is
# the coverage shards, which only ever enter a workspace — so before this target existed these ran
# nowhere in CI, and scripts/workspace/run-workspaces.test.ts sat red on main after #2964 added two
# workspaces without updating it. `make test` still runs them first; this is the same list, callable
# on its own so CI can run it without also running every workspace's suite twice.
test-root: ## Run the repo-root script tests only | repo直下のscript testだけを実行
	bun run test:root
release-report: ## Generate the human release report | 人間向けrelease reportを生成
	bun run release:report
release-check: ## Validate the release manifest and generated report | release manifestと生成reportを検証
	bun run release:check
# Options go through FORM_SETUP_ARGS; make would otherwise parse --repo itself.
# e.g. make form-setup FORM_SETUP_ARGS="--repo owner/name --skip-workflow"
FORM_SETUP_ARGS ?=
form-setup: ## Provision the Google Form backend end to end | お問い合わせフォームのGoogle側を一括構築
	bun run form:setup $(FORM_SETUP_ARGS)
test-coverage: ## Run all coverage shards sequentially | 全coverage shardを直列実行
	bun run test:coverage
# Issue #2515: fast path for script/CLI-only changes (scripts/**/*.ts, infrastructure/test/scripts/*)
# that never touch CDK constructs — runs just that directory, skipping every other workspace and
# every CDK-synth test file. No architecture-invariant / coverage guarantee: it's a quick local
# sanity check before `make before-commit`, not a substitute for it.
test-scripts: ## Run only the fast script and CLI tests | script・CLI関連テストだけを高速実行
	bun run --filter '@TenkaCloud/infrastructure' test test/scripts
# Issues #1295 / #1551: vitest setup pins CDK_OUTDIR to the repo-local
# infrastructure/cdk.out/test-synth/<run>/<worker>. The wrapper purges only its own successful run;
# interrupted, failed, and direct invocations are preserved and reported for manual inspection.
# 依存パッケージの lifecycle script 監査 (mini Shai-Hulud 2nd 対策)。 CI が走らせる。
audit-deps: ## Audit dependency lifecycle-script changes | 依存packageのlifecycle script差分を監査
	bun run audit:dependencies

# jscpd ベースライン・ラチェット。 重複ゼロは強制しない (責務分離の意図的重複は baseline に
# 焼き込み済み)。 baseline を超える新しいコピペ / 再実装だけ fail させる。 CI が走らせる。
dup-check: ## Fail when code duplication grows past the baseline | 重複がbaselineを超えたらfail
	bun run scripts/quality/check-duplication.ts

dup-baseline: ## Re-freeze the duplication baseline (justify increases in the PR) | 重複baselineを現状で更新
	bun run scripts/quality/check-duplication.ts --update

dup-report: ## Show every clone jscpd finds (human-readable) | jscpdの全クローンを表示
	bunx jscpd

# Issue #2758: infrastructure 全体はまだ #1424 の 100% gate 対象外 (report-only) だが、
# AssumeRole/ExternalId・tenant isolation・deploy state machine・scoring・delete lifecycle・
# auth boundary (scripts/quality/infra-critical-paths.ts) は壊れると越境/不正スコアリングに
# 直結するため、jscpd と同じ baseline ratchet 方式で coverage の後退だけを検出する
# (100% gate ではない)。 テストは再実行しない — 既存の infrastructure/coverage/lcov.info を読む。
infra-coverage-check: ## Fail when critical-path infra coverage drops below baseline | high-riskファイルのcoverage低下をfail
	bun run scripts/quality/check-infra-critical-coverage.ts

infra-coverage-baseline: ## Re-freeze the critical-path coverage baseline (justify decreases in the PR) | critical-path coverage baselineを現状で更新
	bun run scripts/quality/check-infra-critical-coverage.ts --update

# knip デッドコードスキャン (#2866 でゲート化)。 knip は「この PR で増えた分」ではなく全量を
# 出すため、 残債 168 件があった間は報告のみだった。 #2866 で全量を 0 に清算したので、 以後の
# 検出 = その PR が持ち込んだ分となりゲートにできる (#2862 の ESLint gate と同じ「清算してから
# 配線」)。 rules は knip.json で error 化済み、 検出があれば exit 1 (~1s)。 false positive の
# 典型は「新しい entrypoint が knip.json の workspace entry glob に無い」ケースで、 正しい修正は
# entry glob の追加 (gate の無効化ではない)。 既知の盲点: root workspace は scripts/** を entry
# 扱いにしているため scripts/ 内の未使用 export は検出対象外 (未使用 file は検出される)。
dead-code: ## Fail on unused files/exports found by knip | knipで未使用コード検出(ゲート)
	bun run dead-code
# Pre-PR gate for the product BODY, run by the pre-commit hook. 品質ゲート (HTTP magic number /
# template / coverage / IAM ASCII / merge / submodule) は本体と混ぜないため
# .claude/skills/quality-gates へ分離済み — pre-commit フックが before-commit とは別呼び出しで
# runner を走らせ、CI は --ci グループを走らせる。
GATE_CHECKS := harness openapi-check lint dead-code test

before-commit: $(GATE_CHECKS) ## Run lint and all tests before committing | commit前のlintと全テストを実行

# Issue #2219: `before-commit` (lint + test) is a fast pre-push sanity check, not a full CI
# mirror — CI (.github/workflows/ci.yml) additionally runs audit-deps / the submodule pin
# guard / coverage-gate (100% for agent-owned workspaces) / build, so a green `before-commit`
# does not guarantee a green CI. `ci-local` runs everything CI runs, in CI's own order, minus
# the Codecov upload step (network + secret, not meaningful to run locally).
# Issue #2513: CI runs this same workspace set as a 3-shard matrix (`coverage` job,
# infrastructure / spas / packages) via `scripts/workspace/run-coverage.ts --shard <name>` +
# `.claude/skills/quality-gates/scripts/check-coverage-gate.ts --shard <name>`, run in parallel
# with the `ci` job. `test-coverage` below (and `ci-local`, which chains it) instead runs all
# 3 shards serially in one process — same checks, same workspace set, intentionally different
# parallelism.
ci-local: ## Run the full GitHub Actions gate locally | GitHub Actions相当の全gateをローカル実行
	bun run .claude/harness/bin/architecture.ts --fail-on=error
	$(MAKE) harness-test
	git fetch --no-tags origin main:refs/remotes/origin/main
	git -C problems fetch --tags --unshallow origin 2>/dev/null || git -C problems fetch --tags origin || true
	$(MAKE) audit-deps
	$(MAKE) dup-check
	$(MAKE) dead-code
	bun run .claude/skills/quality-gates/scripts/run.ts submodule-not-behind
	$(MAKE) validate-problems
	$(MAKE) lint-text
	$(MAKE) lint-format
	$(MAKE) lint-ts
	$(MAKE) test-root
	$(MAKE) typecheck
	$(MAKE) test-coverage
	bun run .claude/skills/quality-gates/scripts/run.ts coverage-gate
	$(MAKE) build

# ===== Lint / Fix | Lint / 修正 =====
# Issue #2862: `lint:ts` は #2861 で package.json に入ったが Makefile からも CI からも呼ばれず、
# 一度も走っていなかった (= 走らせたら parser error で 97 file が無検査だった)。`lint` に足して
# `before-commit` (GATE_CHECKS) 経路に載せ、CI 側は下の "ESLint (type-aware)" step で個別に呼ぶ。
#
# ESLint の対象は #3014 で `scripts/` からリポジトリ全体へ広げた。 既存 1,694 件は
# `eslint-suppressions.json` に ceiling として焼いてあり (ESLint 純正の bulk suppressions)、
# 新しい違反だけが落ちる。 詳細は `lint-ts` / `lint-ts-prune` の項を参照。
lint: lint-md lint-text lint-format lint-eslint-scope lint-ts ## Check Markdown, prose, code formatting, and typed TS lint | Markdown・文章・code format・型付きTS lintを検査
fix: fix-md fix-text fix-format ## Fix all automatically repairable lint issues | lint可能な問題を一括修正
format: fix ## Apply the same automatic fixes as make fix | fixと同じ一括整形を実行

lint-md: ## Check Markdown conventions | Markdown規約を検査
	bun run lint:md
lint-text: ## Check Japanese and technical-writing conventions | 日本語・技術文章規約を検査
	bun run lint:text
lint-format: ## Check code formatting with Biome | Biomeでcode formatを検査
	bun run lint:format
# #3014: 対象は repo 全体 (`eslint .`)。 型情報を要する rule は引き続き `scripts/**` だけに
# 効く (eslint.config.js の typedSourceFiles) が、 strict / stylistic / sonarjs は全 workspace に
# 効く。 既存違反は `eslint-suppressions.json` に file × rule の件数として焼いてあり、 その件数
# **以下**なら緑、 1 件でも超えたら赤。
#
# 違反を直して件数が ceiling を下回ると ESLint は
# "There are suppressions left that do not occur anymore" で exit 2 になる。 これは失敗ではなく
# 「ceiling を下げろ」という催促で、 `make lint-ts-prune` を実行して差分を commit するのが正しい
# 応答 (= ratchet が下がる唯一の経路)。 ceiling を手で編集しないこと。
#
# 並行 agent 運用では複数の branch が同時に prune して `eslint-suppressions.json` が衝突する。
# 解決はどちらかを選ぶのではなく、 **merge 後の tree で `make lint-ts-prune` を流し直す**こと。
# 片側を採用すると、 もう片側で直したはずの違反が ceiling に残り regression を素通しする。
lint-ts: ## Check the whole repo with ESLint against the frozen ceiling | repo全体をESLintで検査(既存違反はceilingで凍結)
	bun run lint:ts
# ESLint の ignores が .gitignore から drift していないか検査する。 drift すると生成物や nested
# worktree まで lint 対象になり、 ceiling が machine 依存になる (#3014 で実際に踏んだ)。
lint-eslint-scope: ## Fail when ESLint would lint git-ignored paths | ESLintがgit-ignored pathを対象にしていたら落とす
	bun run lint:eslint-scope
lint-ts-prune: ## Lower the ESLint ceiling to today's violation count | ESLintのceilingを現在の違反件数まで下げる
	bun run lint:ts:prune
fix-md: ## Automatically fix Markdown violations | Markdown規約違反を自動修正
	bun run fix:md
fix-text: ## Automatically fix prose violations | 文章規約違反を自動修正
	bun run fix:text
fix-format: ## Automatically format code with Biome | Biomeでcode formatを自動修正
	bun run fix:format

# ===== Harness | Harness =====
HARNESS := bun run .claude/harness/bin
harness: ## Check architecture invariants | architecture invariant違反を検査
	$(HARNESS)/architecture.ts --staged --fail-on=error
harness-test: ## Run the harness unit tests | harness自身のunit testを実行
	cd .claude/harness && bun vitest run
tech-debt: ## Generate the technical-debt backlog | tech debt backlogを生成
	$(HARNESS)/tech-debt.ts

# ===== OpenAPI | OpenAPI =====
# Issue #2949: machine API surface の spec は `MACHINE_ROUTE_SCOPES` と handler の zod schema から
# 生成する。手書きの path も手書きの schema も無いので、route を足して生成物を更新し忘れた PR は
# `openapi-check` が落とす。`openapi-check` は GATE_CHECKS に入れてあり before-commit で走る。
openapi: ## Generate the machine API OpenAPI spec | machine API の OpenAPI spec を生成
	bun run scripts/openapi/generate.ts
openapi-check: ## Fail when the committed OpenAPI spec drifts from the source of truth | OpenAPI 生成物の drift を検査
	bun run scripts/openapi/generate.ts --check

# ever-better (https://github.com/isamu/ever-better) の read-only 診断のみを配線する。
# 何をするツールか: リポジトリの品質ツール構成を検出し、(a) 不足している層、(b) 600行超の file 数、
# (c) `eslint --print-config` で「実際に適用される設定」を引いて off / warn-only になっている
# high-value rule を報告する。(c) は config の source を読むのではなく実効値を引くため、
# preset 同士の上書きで黙って off になった rule を検出できる (= このレポの「synth 出力を機械
# チェック」と同じ発想)。
#
# 意図的に GATE_CHECKS と .github/workflows/ci.yml のどちらにも載せない:
#   - 2026-08-08 公開の新規 package で download 実績ゼロ・3時間半で 0.1.0→0.4.0 の4版・
#     単独 maintainer。公開後72時間は無条件に unpublish 可能で、その窓を抜けた後も「public な
#     dependent が無く download が少なく単独 owner」の条件を満たす限り unpublish 対象のまま
#     (このレポは private なので dependent には数えられない)。gate のロジックが消え得るものに
#     依存する状態を作らない。runtime dependency は 0 件・MIT・install 時の lifecycle script
#     なし (`prepack` のみ = publish 時) で supply-chain 面の素性は良いが、それは「消えない」
#     保証ではない。devDependency である以上 `bun install` は解決を要するので、その分の露出は
#     残る (= 放置されたらこの target と依存ごと削除する、が撤退手順)。
#   - report-only なので exit code に意味を持たせていない。
#
# ratchet 自体は #3014 で導入済みだが、ever-better ではなく **素の ESLint** で実装した。
# bulk suppressions (`--suppress-all` / `--prune-suppressions` / `--pass-on-unpruned-suppressions`)
# は ESLint 9.39 に元から入っており、ever-better の README 自身が「ratchet の再実装はしていない」
# と明記している。同じ機構を新規 gate 依存ゼロで使えるので、上記の存続性リスクを gate に持ち込む
# 理由が無い。運用は `lint-ts` / `lint-ts-prune` を参照。
#
# `ever-better bootstrap` は実行しないこと: Prettier を入れる (このレポの formatter は Biome)、
# ESLint 10 を要求する (このレポは ^9 + typescript-eslint ^8)、生成する workflow が
# `npx --yes` を使う (このレポの npx 禁止に反する)、dependabot.yml / .gitattributes /
# 3プラットフォーム workflow を勝手に書く。
#
# このレポでの既知の false positive (追いかけないための記録。いずれも detector が root 直下の
# 慣習を前提にしているため):
#   - "No TypeScript"  … 同じ出力の中で 99% TypeScript と報告しており自己矛盾。root に
#                         tsconfig.json が無く tsconfig.scripts.json / 各 workspace 側にある。
#   - "No formatter"   … Prettier の有無だけを見ており Biome を知らない。
#   - "No test runner" … vitest が root devDependency でなく workspace 側にある。
#   - "CI does not run lint" … CI の step が全て `run: make <target>` なので直接の tool 呼び出しを
#                         見つけられず `[no known steps]` になる。実際は lint-text / lint-format /
#                         lint-ts を実行している。
#
# `--json` や他の subcommand を試す場合は ./node_modules/.bin/ever-better を直接呼ぶ。
ever-better-diagnose: ## Report quality-tooling gaps and non-enforcing ESLint rules (read-only) | 品質ツールの不足と無効化されたESLint ruleを報告(読み取り専用)
	./node_modules/.bin/ever-better diagnose

# ===== Problem catalog validation | 問題カタログ検証 =====
# Run the catalog authoring-contract validator (schema + the bilingual-README invariant from
# TenkaCloudChallenge #136: each problem dir must carry non-empty, non-symlink README.md +
# README.ja.md) against the platform's problems/ mirror. This makes a README-less / schema-invalid
# problem fail platform CI too — not only the catalog repo's own CI — closing the drift #2254 flags.
# problems/ is a git submodule (not a workspace member), so its own deps (ajv etc.) install here.
validate-problems: ## Validate problem schemas and bilingual READMEs | 問題catalogのschemaと日英READMEを検証
	git submodule update --init problems
	cd problems && bun install --frozen-lockfile --ignore-scripts && bun run scripts/validate-problems.ts

# ===== Problem Packs (author-side CLI) | 問題パック（作成者向けCLI） =====
# Thin delegation to the offline `pack` CLI (infrastructure/lib/problem-pack/pack-cli.ts,
# entry infrastructure/bin/tenkacloud-pack.ts). ARGS carries the subcommand's own
# positionals/flags verbatim — this Makefile never parses pack syntax itself. Examples:
#   make pack-init ARGS="./my-pack --runtime aws/cloudformation"
#   make pack-validate ARGS="./my-pack"
#   make pack-install ARGS="./my-pack"
#   make pack-install ARGS="git https://github.com/<you>/my-pack --commit <full-40hex-sha>"
#   make pack-activate ARGS="my-pack@1.0.0 --tenant demo"
#   make pack-deactivate ARGS="my-pack@1.0.0 --tenant demo"
#   make pack-list ARGS="--json"
# Full subcommand reference (incl. `inspect` / `remove`, not wrapped here):
# infrastructure/lib/problem-pack/pack-cli.ts
#
# CWD constraint: the CLI's default store (`.tenkacloud/pack-store`, pack-cli.ts) resolves
# relative to the process CWD, and the Lite synth reads it from the REPO ROOT
# (infrastructure/bin/tenkacloud-lite.ts resolves binDir/../../.tenkacloud/pack-store).
# So the CLI must run with CWD = repo root — do NOT switch this to a
# `cd infrastructure && bun run pack` form, or default-store installs land in
# infrastructure/.tenkacloud/pack-store where nothing reads them.
PACK := ./node_modules/.bin/tsx infrastructure/bin/tenkacloud-pack.ts

pack-init: ## Scaffold a problem pack | 問題packの雛形を作成
	$(PACK) init $(ARGS)
pack-validate: ## Validate a problem pack manifest and assets | 問題packのmanifestとassetを検証
	$(PACK) validate $(ARGS)
pack-install: ## Install a problem pack into the local store | 問題packをlocal storeへinstall
	$(PACK) install $(ARGS)
pack-activate: ## Activate an installed pack for a tenant | install済みpackをtenantで有効化
	$(PACK) activate $(ARGS)
pack-deactivate: ## Deactivate a problem pack for a tenant | tenantの問題packを無効化
	$(PACK) deactivate $(ARGS)
pack-list: ## List installed problem packs | install済み問題packを一覧表示
	$(PACK) list $(ARGS)

# ===== CDK | CDK =====
# 環境切替。make deploy ENV=production 等で上書き可能。デフォルトは development。
ENV ?= development
ENV_FILE := infrastructure/environments/$(ENV)/.env

# infrastructure/environments/$(ENV)/.env を自動 load (無ければ warn)。
# .env から SYSTEM_ADMIN_EMAIL / AWS_ACCOUNT_ID / AWS_REGION を読み、
# install.sh / CDK が期待する環境変数名 (CDK_PARAM_*) にも export する。
-include $(ENV_FILE)
export

# synth/diff を Makefile 単体で通す時の placeholder (install.sh は deploy 時に上書きする)。
CDK_PARAM_SYSTEM_ADMIN_EMAIL ?= $(SYSTEM_ADMIN_EMAIL)
# Deploy uses a globally-unique, account-scoped source bucket — a fixed name
# collides across accounts (S3 bucket names are global). Compute it only when
# BOTH the account and a region are known, resolving the region as
# AWS_REGION -> AWS_DEFAULT_REGION to match prepare-source-bundle.sh's env order
# (so the name the script uploads to and the name cdk reads always agree — we
# never guess a region). Otherwise keep a DNS-valid placeholder for `make synth`
# without creds (fromBucketName validates 3-63 lowercase chars); the script then
# resolves the region itself (incl. `aws configure`) and computes the name.
TC_SOURCE_REGION := $(or $(strip $(AWS_REGION)),$(strip $(AWS_DEFAULT_REGION)))
CDK_PARAM_S3_BUCKET_NAME ?= $(if $(and $(strip $(AWS_ACCOUNT_ID)),$(TC_SOURCE_REGION)),tenkacloud-source-$(strip $(AWS_ACCOUNT_ID))-$(TC_SOURCE_REGION),tenkacloud-source-placeholder)
CDK_SOURCE_NAME ?= source.zip
CDK_PARAM_COMMIT_ID ?= placeholder

env-check: ## Validate the SaaS deployment environment | SaaS deploy用の環境設定を検証
	@[ -f "$(ENV_FILE)" ] || { \
		echo "ERROR: $(ENV_FILE) が存在しません。"; \
		echo "       cp infrastructure/environments/$(ENV)/.env.example infrastructure/environments/$(ENV)/.env"; \
		echo "       してから必須値 (SYSTEM_ADMIN_EMAIL / AWS_ACCOUNT_ID) を埋めてください。"; \
		exit 1; \
	}
	@[ -n "$${SYSTEM_ADMIN_EMAIL}" ] || { \
		echo "ERROR: SYSTEM_ADMIN_EMAIL が $(ENV_FILE) にありません"; exit 1; \
	}

# Lite mode は SBT ControlPlane を立てないため SYSTEM_ADMIN_EMAIL は必須にしない。
# ただし Application Admin Console にログインする tenant admin の email は必須 (= deploy
# 後に Cognito UserPool へ admin-create-user で 1 user を起こすため、 無いとログイン不能)。
# 互換のため SYSTEM_ADMIN_EMAIL でも fallback 可。
env-check-lite: ## Validate the Lite deployment environment | Lite deploy用の環境設定を検証
	@[ -f "$(ENV_FILE)" ] || { \
		echo "ERROR: $(ENV_FILE) が存在しません。"; \
		echo "       make env-init  で対話 wizard から生成できます (Issue #1345)、 または"; \
		echo "       cp infrastructure/environments/$(ENV)/.env.example infrastructure/environments/$(ENV)/.env"; \
		echo "       して AWS_ACCOUNT_ID / TENANT_ADMIN_EMAIL を埋めてください。"; \
		exit 1; \
	}
	@if [ -z "$${TENANT_ADMIN_EMAIL}" ] && [ -z "$${SYSTEM_ADMIN_EMAIL}" ]; then \
		echo "ERROR: TENANT_ADMIN_EMAIL が $(ENV_FILE) にありません (= Application Admin Console の初期ユーザー宛先)"; \
		echo "       SYSTEM_ADMIN_EMAIL でも代用可能ですが、 Lite mode では TENANT_ADMIN_EMAIL を推奨します"; \
		exit 1; \
	fi
	@case "$${CDK_PARAM_CONTROL_DATA_BACKEND}" in \
		turso) \
			missing=""; \
			[ -n "$${CDK_PARAM_TURSO_DATABASE_URL}" ] || missing="$${missing} CDK_PARAM_TURSO_DATABASE_URL"; \
			[ -n "$${CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME}" ] || missing="$${missing} CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME"; \
			if [ -n "$${missing}" ]; then \
				echo "ERROR: CDK_PARAM_CONTROL_DATA_BACKEND=$${CDK_PARAM_CONTROL_DATA_BACKEND} には以下が $(ENV_FILE) に必要です:"; \
				for v in $${missing}; do echo "       $${v}"; done; \
				echo "       make turso-live ENV=$(ENV) で対話設定を開始してください"; \
				exit 1; \
			fi \
			;; \
	esac

# Issue #1345: Lite mode の first-run UX。 .env.example を読んで対話的に必須 3 vars
# (TENANT_ADMIN_EMAIL / AWS_REGION / CDK_PARAM_DEPLOY_EXTERNAL_ID) を埋め、
# infrastructure/environments/$(ENV)/.env を生成する。 既存 .env があれば skip。
env-init: ## Create the Lite .env file interactively | Lite用.envを対話wizardで作成
	@ENV=$(ENV) bun run scripts/ops/env-init.ts

# Issue #2617: Turso pure-SQL profile の初回 live E2E を「資料を探す」状態から、1 本の
# discoverable な導線へまとめる。guide は副作用なし、preflight / verify-cfn は AWS read-only。
# deploy は CLI 側で exact confirmation を要求し、destroy は意図的に内包しない。
turso-live: ## Start the interactive Turso/AWS live verification wizard | Turso/AWSの初回live検証wizardを開始
	@ENV=$(ENV) bun run tenkacloud turso-live

turso-live-guide: ## Show the Turso live-verification guide only | Turso live検証の手順だけを表示
	@ENV=$(ENV) bun run tenkacloud turso-live guide

turso-live-preflight: env-check-lite ## Validate Turso, AWS, and SSM settings read-only | Turso/AWS/SSM設定をread-only検証
	@ENV=$(ENV) bun run tenkacloud turso-live preflight

turso-live-verify-cfn: ## Verify deployed stacks contain no DynamoDB tables | deploy済みstackとDynamoDB 0件を検証
	@ENV=$(ENV) bun run tenkacloud turso-live verify-cloudformation

turso-reset: ## Delete all Turso control-data rows, keep schema | Tursoのcontrol-data全行を削除(スキーマ維持)
	@ENV=$(ENV) bun run tenkacloud turso-live reset

# Issue #955: デフォルトの make deploy は Lite (= single-tenant) mode。
# 大半の利用者は 1 人 1 大会の主催で multi-tenant 抽象 (= SBT ControlPlane / tenant pipeline /
# tenant mapping table) を必要としない。 Lite mode は Application Plane (= Tenant Admin Console)
# と Participant Portal を `tenantId="local"` 固定で立てる (ADR-016)。
#   - Lite で deploy: tenkacloud-lite + tenkacloud-lite-problem-deploy
#   - SaaS が必要なら `make deploy-saas` (= 旧 default、 3-phase orchestration)
# `build` を必ず先に走らせる: 問題カタログは SPA build 時に `import.meta.glob` で
# `problems/**/metadata.json` を取り込む (apps/*/src/data/problems.ts) ため、 submodule を
# 最新化しても SPA を再 build しないと dist が古いカタログのまま deploy され、 新規問題が
# 取り込まれない。 そのため deploy 系は build を prereq 化する。
deploy: env-check-lite build ## Deploy Lite mode to AWS | Lite modeをAWSへdeploy
	bun run scripts/tenkacloud-lite.ts up
# ref の install.sh 準拠の orchestration (= SaaS mode、 SBT ControlPlane を立てる):
#   1. S3 source bucket (serverless-saas-${ACCOUNT_ID}-${REGION}) を作成
#   2. infrastructure/ を source.zip にして S3 に upload
#   3. cdk bootstrap + cdk deploy --all (ControlPlane + Bootstrap + Tenant-pooled)
#   4. client/client-template deploy (CloudFront + S3 for Admin/Application UI)
deploy-saas: env-check ## Deploy multi-tenant SaaS mode to AWS | multi-tenant SaaS modeをAWSへdeploy
	@cd scripts && bash install.sh "$${SYSTEM_ADMIN_EMAIL}"
#: CDK が construct 内部で singleton として作る provider Lambda (S3AutoDeleteObjects /
#: AWSCDKOpenIdConnectProvider) は log 設定の prop を公開していないので、 その log group は
#: 無期限保持のまま生まれる (#2960)。 deploy 直後に backstop を当てて拾う。
	bash scripts/enforce-log-retention.sh

enforce-log-retention: env-check ## Fill in retention on tenkacloud log groups that have none | retention 未設定の log group に retention を当てる
	bash scripts/enforce-log-retention.sh

destroy: env-check-lite ## Delete Lite-mode AWS resources | Lite modeのAWS resourceを削除
	bun run scripts/tenkacloud-lite.ts down
destroy-all: env-check-lite ## Delete Lite stacks and retained data | Lite stackと保持データを完全削除
	bun run scripts/tenkacloud-lite.ts down --purge-retained-data
destroy-saas: env-check ## Delete SaaS-mode AWS resources | SaaS modeのAWS resourceを削除
	bash scripts/cleanup.sh

# ===== Local dev (no AWS) | ローカル開発（AWS不要） =====
# Issue #2228: AGENTS.md "SPA dev servers" documented this target before it existed.
# Starts all 3 SPA dev servers in parallel (admin-console :5173 / application-admin-console
# :5174 / participant-portal :5175). Ctrl-C stops all three (bun --parallel propagates SIGINT).
dev: ## Start all three SPA dev servers without AWS | 3つのSPA dev serverをAWSなしで起動
	bun run scripts/ops/participant-portal-runtime-config.ts --cloud-mode mock
	bun run --filter '@TenkaCloud/admin-console' --filter '@TenkaCloud/application-admin-console' --filter '@TenkaCloud/participant-portal' --parallel dev

# ===== Synth (no deploy) | Synth（デプロイなし） =====
# Issue #2228: AGENTS.md / infrastructure/bin/infrastructure.ts referenced `make check-synth`
# and `make synth` as the offline infra-review gate before either existed.
#   - `synth`: full CFn synth (real Lambda bundling — slow, matches what `deploy` runs).
#   - `check-synth`: fast synth-only shape check (CDK_SKIP_BUNDLING=1 skips Docker Lambda
#     bundling, #1446) + the IAM Description ASCII gate (#664) that only sees synth output.
#     This is the "infra changes carry extra care" verification step AGENTS.md's Role
#     split section points agents at.
synth: ## Synthesize every CDK stack with bundling | 全CDK stackをbundle込みでsynth
	$(CDK) synth --quiet

check-synth: export CDK_SKIP_BUNDLING := 1
check-synth: ## Run fast CDK synth and the IAM ASCII check | 高速CDK synthとIAM ASCII検査を実行
	$(CDK) synth --quiet
	bun run .claude/skills/quality-gates/scripts/check-synth-iam-ascii.ts

# ===== Local play (Docker, no AWS) | ローカル演習（Docker、AWS不要） =====
# Issue #2054: AWS 非依存の CTF コンテナ。 問題コンテナが `/verify` と採点条件を持ち、
# TenkaCloud は採点 (participant API / portal / leaderboard / hint) だけを担う。 Kumo は撤去。
#   make local                     採点 API + Participant Portal を起動 (問題コンテナは必要時に起動)
#   make local PROBLEM=sqli-demo   問題コンテナを pre-start し、採点 API + Portal を起動
#   make local-up                  採点 API のみを起動 (上級者向け)
#   make local-portal              既存の採点 API に Participant Portal を接続
#   make local-down                停止 + runtime-config 復元 + 全進捗消去
#   make local-evaluate FLAG=...   採点 API 経由でフラグを提出 (= 問題コンテナ /verify に委譲)
#   TENKACLOUD_COMPOSE_CLI='docker-compose'  standalone compose を明示
# Issue #2119: `make local-onboard YES=1` pre-approves software installs (also for automation).
ONBOARD_FLAGS := $(if $(YES),--yes,)

# Issue #2119: report-only prerequisite diagnosis (mise trust / submodule / bun /
# Docker Compose / daemon). Installs nothing.
# Issue #2909: `make doctor PROFILE=recommended` additionally compares the
# resources Docker actually has against that profile's measured configuration.
# `PROBE_DISK=1` opts in to the one non-read-only check (it pulls busybox to read
# the Docker VM's free space, which the host's own `df` cannot see on macOS).
DOCTOR_FLAGS := $(if $(PROFILE),--profile $(PROFILE),)$(if $(PROBE_DISK), --probe-disk,)
doctor:
	@command -v bun >/dev/null 2>&1 || { \
	  echo "Bun is required for diagnostics."; \
	  echo "  Install (macOS / Linux): bash scripts/onboard/install-bun.sh"; \
	  exit 1; }
	@bun run tenkacloud doctor $(DOCTOR_FLAGS)

# Issue #2909: re-runnable resource benchmark. Starts the profile's problems
# through the already-running local-play API, samples only TenkaCloud-owned
# containers, stops them, asserts they were reclaimed, and writes a record under
# docs/measurements/local-mode/. Requires `make local` to be running first.
#   make local-measure PROFILE=minimum PROBLEMS=sqli-demo PHASE=warm
local-measure: ## Measure a local-mode resource profile and write a JSON record | ローカル動作要件を実測しJSONへ記録
	@$(MAKE) ensure-deps
	@PROFILE="$(PROFILE)" PROBLEMS="$(PROBLEMS)" PHASE="$(PHASE)" RELEASE="$(RELEASE)" \
	  HOST_DESCRIPTION="$(HOST_DESCRIPTION)" OUT="$(OUT)" \
	  bun run scripts/local/measure-profile.ts

# Issue #2119: optional guided setup for the DEVELOPER Bun/Vite path
# (`make local-dev`). The participant path (`make local`, Issue #2906) is
# Docker-only and needs none of this — see scripts/local/docker-launcher.sh.
local-onboard:
	@sh scripts/onboard/onboard-bootstrap.sh $(ONBOARD_FLAGS)
	@# The bootstrap may have JUST installed bun into ~/.bun/bin; this recipe line
	@# runs in a fresh shell whose PATH predates that install, so prefix it.
	@PATH="$$HOME/.bun/bin:$$PATH" bun run scripts/tenkacloud-onboard.ts preflight $(ONBOARD_FLAGS)

# Self-heal missing dependencies so `make local-dev` is a single entry point: on
# a fresh clone / Codespace that never ran `make install`, the portal's vite is
# absent and local play used to die with "run make install first". Install once
# (only when vite is missing — a no-op on a warm tree), then continue.
# Issue #2907: this must run BEFORE any `bun run tenkacloud ...` — the CLI's
# static import graph pulls in external packages, so on a fresh clone module
# resolution fails before the CLI's own self-heal can execute. Checking bun here
# also turns "bun: command not found" into the actionable next command.
ensure-deps:
	@command -v bun >/dev/null 2>&1 || { \
	  echo "Bun is required for local play but was not found."; \
	  echo "  Run the guided setup first: make local-onboard"; \
	  echo "  Or install Bun directly:    bash scripts/onboard/install-bun.sh"; \
	  exit 1; }
	@if [ ! -x node_modules/.bin/vite ] && [ ! -x apps/participant-portal/node_modules/.bin/vite ]; then \
	  echo "Dependencies are not installed (vite is missing) — running 'make install' first."; \
	  $(MAKE) install; \
	fi

# Issue #2906: the participant entry point. Docker Engine + Docker Compose v2
# only — no Bun, Node, or node_modules on the host. See
# scripts/local/docker-launcher.sh and compose.local.yaml.
local: ## Start the local drill API and portal via Docker (participant path) | Docker でローカル問題演習を起動(参加者向け)
	@sh scripts/local/docker-launcher.sh up

local-down: ## Stop local play and clear all persisted progress | local playを停止して全進捗を消去
	@sh scripts/local/docker-launcher.sh down

local-status:
	@sh scripts/local/docker-launcher.sh status

# Issue #2054 / #2392 / #2511 / #2906: the DEVELOPER path — the same
# local-play engine, run directly on the host with Bun/Vite (hot reload, no
# container rebuild per change) instead of Docker. Run `make local-onboard`
# first on a fresh clone.
local-dev: ## Start local play on the host with Bun/Vite (developer path, hot reload) | ホストで Bun/Vite により起動(開発者向け・ホットリロード)
	@$(MAKE) ensure-deps
	@bun run tenkacloud local $(if $(PROBLEM),--problem "$(PROBLEM)",) $(if $(LOCAL_API_PORT),--api-port "$(LOCAL_API_PORT)",)

local-up:
	@$(MAKE) ensure-deps
	@bun run tenkacloud local up $(if $(PROBLEM),--problem "$(PROBLEM)",) $(if $(LOCAL_API_PORT),--api-port "$(LOCAL_API_PORT)",)

local-portal:
	@$(MAKE) ensure-deps
	@bun run tenkacloud local portal

# Issue #2188: list local-play problems (id / category / display name) for
# players who want to pre-start one by id.
local-list:
	@bun run tenkacloud local list

local-evaluate:
	@if [ -z "$(FLAG)" ]; then \
	  echo "error: FLAG is required. Example: make local-evaluate FLAG='TC{...}'" >&2; \
	  exit 1; \
	fi
	@bun run tenkacloud local evaluate "$(FLAG)"

local-reset:
	@if [ -z "$(PROBLEM)" ]; then \
	  echo "error: PROBLEM is required. Example: make local-reset PROBLEM=hello-world" >&2; \
	  exit 1; \
	fi
	@bun run tenkacloud local reset "$(PROBLEM)"

local-snapshot-export:
	@if [ -z "$(PROBLEM)" ]; then \
	  echo "error: PROBLEM is required. Example: make local-snapshot-export PROBLEM=hello-world SNAPSHOT=before-change" >&2; \
	  exit 1; \
	fi
	@SNAPSHOT="$(SNAPSHOT)" bun run tenkacloud local snapshot-export "$(PROBLEM)"

local-snapshot-import:
	@if [ -z "$(PROBLEM)" ]; then \
	  echo "error: PROBLEM is required. Example: make local-snapshot-import PROBLEM=hello-world SNAPSHOT=before-change" >&2; \
	  exit 1; \
	fi
	@SNAPSHOT="$(SNAPSHOT)" bun run tenkacloud local snapshot-import "$(PROBLEM)"

local-disrupt:
	@if [ -z "$(PROBLEM)" ] || [ -z "$(DISRUPTION)" ]; then \
	  echo "error: PROBLEM and DISRUPTION are required. Example: make local-disrupt PROBLEM=hello-world-battle DISRUPTION=frontend-down" >&2; \
	  exit 1; \
	fi
	@DISRUPTION="$(DISRUPTION)" bun run tenkacloud local disrupt "$(PROBLEM)"

# E2E smoke: start one local-play problem, assert every container reaches a
# healthy / one-shot-complete state, then tear it down. Runnable before a commit
# and in CI to catch a problem whose containers fail to start (broken compose,
# wrong image, an unhealthy service, or a full Docker VM disk). Preflights the VM
# disk so a full disk is reported plainly instead of a cryptic 502 start_failed.
# Defaults to a light single-container problem; override with PROBLEM=<id>.
local-smoke:
	@$(MAKE) ensure-deps
	@PROBLEM="$(PROBLEM)" bun run scripts/local-play/local-smoke.ts

# ===== Problem deploy smoke test | 問題デプロイのスモークテスト =====
# 引数に問題フォルダを取り、順次 CFn deploy する開発者向け smoke test ツール。
# SaaS 配線 (Step Functions / EventBridge / tenant API / Cognito) を持ち込まず、
# CFn template と AWS 権限の正しさだけを確認する。
#
# `BATTLES` は **必須** (= default を持たない)。引数なしで `make deploy-battles` を叩いた
# ときに silently deploy が始まる事故を防ぐため、明示指定を要求する。
#
# 使い方:
#   make deploy-battles BATTLES="problems/battles/security-battle-royale"
#   make deploy-battles BATTLES="problems/battles/security-battle-royale problems/battles/another"
#   make deploy-battles BATTLES="problems/battles/security-battle-royale" TEAM_SLUG=alpha
TEAM_SLUG ?= demo-team

deploy-battles: ## Smoke-deploy selected problem templates to AWS | 指定した問題templateをAWSへsmoke deploy
	@if [ -z "$(BATTLES)" ]; then \
	  echo "error: BATTLES が未指定。例: make deploy-battles BATTLES=\"problems/battles/security-battle-royale\"" >&2; \
	  exit 1; \
	fi
	@TEAM_SLUG="$(TEAM_SLUG)" bash scripts/deploy-battles.sh $(BATTLES)
destroy-battles: ## Delete smoke-deployed problem stacks | smoke deployした問題stackを削除
	@if [ -z "$(BATTLES)" ]; then \
	  echo "error: BATTLES が未指定。例: make destroy-battles BATTLES=\"problems/battles/security-battle-royale\"" >&2; \
	  exit 1; \
	fi
	@TEAM_SLUG="$(TEAM_SLUG)" bash scripts/destroy-battles.sh $(BATTLES)

# ===== Always-On OIDC command seam (ADR-050) | Always-On OIDCコマンド境界（ADR-050） =====
# Worker (slice A の OIDC IdP) を IAM OIDC provider として登録し、frozen `tenkacloud.deploy` を
# `events:PutEvents` する以外なにもできない federated role `tenkacloud-alwayson-command` を立てる。
# event 非依存の singleton bootstrap (bin/tenkacloud-always-on-command.ts)。
#
# 必須 env: CDK_PARAM_ALWAYS_ON_ISSUER_URL (= Worker origin。/.well-known/openid-configuration を配信) /
#           CDK_PARAM_EVENT_BUS_ARN (= 既存 deploy bus の ARN)。
# 任意 env: CDK_PARAM_ALWAYS_ON_OIDC_PROVIDER_ARN (既存 provider を import) /
#           CDK_PARAM_ALWAYS_ON_COMMAND_SUBJECT (sub claim pattern override) /
#           CDK_PARAM_ALWAYS_ON_COMMAND_ROLE_NAME (物理 role 名 override)。
#
# 使い方:
#   make deploy-always-on-command \
#     CDK_PARAM_ALWAYS_ON_ISSUER_URL=https://tenkacloud-always-on-control-plane.example.workers.dev \
#     CDK_PARAM_EVENT_BUS_ARN=arn:aws:events:ap-northeast-1:123456789012:event-bus/...
ALWAYS_ON_COMMAND_APP := bunx tsx bin/tenkacloud-always-on-command.ts

deploy-always-on-command: ## Deploy the Always-On OIDC command seam | Always-On OIDC command seamをdeploy
	@if [ -z "$${CDK_PARAM_ALWAYS_ON_ISSUER_URL}" ]; then \
	  echo "error: CDK_PARAM_ALWAYS_ON_ISSUER_URL が未指定 (= OIDC discovery を配信する Worker origin)。" >&2; \
	  echo "  例: make deploy-always-on-command CDK_PARAM_ALWAYS_ON_ISSUER_URL=https://<worker>.workers.dev" >&2; \
	  exit 1; \
	fi
	@if [ -z "$${CDK_PARAM_EVENT_BUS_ARN}" ]; then \
	  echo "error: CDK_PARAM_EVENT_BUS_ARN が未指定 (= command role が PutEvents する既存 deploy bus)。" >&2; \
	  exit 1; \
	fi
	$(CDK) deploy --app "$(ALWAYS_ON_COMMAND_APP)" --all $(APPROVAL)

synth-always-on-command: export CDK_SKIP_BUNDLING := 1
synth-always-on-command: ## Synthesize the Always-On OIDC command seam | Always-On OIDC command seamをsynth
	$(CDK) synth --app "$(ALWAYS_ON_COMMAND_APP)" --quiet

destroy-always-on-command: ## Delete the Always-On OIDC command seam | Always-On OIDC command seamを削除
	@if [ -z "$${CDK_PARAM_ALWAYS_ON_ISSUER_URL}" ] || [ -z "$${CDK_PARAM_EVENT_BUS_ARN}" ]; then \
	  echo "error: CDK_PARAM_ALWAYS_ON_ISSUER_URL / CDK_PARAM_EVENT_BUS_ARN が未指定 (destroy も app synth のため必須)。" >&2; \
	  exit 1; \
	fi
	$(CDK) destroy --app "$(ALWAYS_ON_COMMAND_APP)" --all --force

# ===== Always-On per-event runtime (ADR-049 Phase 4) | Always-Onイベント別runtime（ADR-049 Phase 4） =====
# command seam (上) は event 非依存の singleton。ここは event ごとに立て/畳む per-event runtime stack
# (bin/tenkacloud-always-on-runtime.ts)。stack id は tenkacloud-event-runtime-<eventId> で、
# deploy/destroy とも **その 1 stack のみ** を対象にする (`--all` は使わない = 他 event / command seam を
# 巻き込まない)。stack は runtime-tags (TenkaCloud:ManagedBy=always-on-runtime 他) を付与するので、
# 夜間 sweeper が期限切れ runtime を検出・削除できる。
#
# 必須 env: lifecycle 3 値に加え、runtime scoring が参照する既存 event-data table 名、
# Workers URL、SSM SecureString の score-feed token parameter 名。
ALWAYS_ON_RUNTIME_APP := bunx tsx bin/tenkacloud-always-on-runtime.ts
ALWAYS_ON_RUNTIME_STACK := tenkacloud-event-runtime-$(CDK_PARAM_ALWAYS_ON_EVENT_ID)

deploy-always-on-runtime: ## Deploy an event-scoped Always-On runtime | event単位のAlways-On runtimeをdeploy
	@if [ -z "$${CDK_PARAM_ALWAYS_ON_EVENT_ID}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_TENANT_ID}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_EXPIRES_AT}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_DEPLOYMENTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_EVENTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_ENDPOINTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_CONTROL_PLANE_URL}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_ARCHIVE_BUCKET_NAME}" ]; then \
	  echo "error: Always-On runtime lifecycle/scoring の必須 CDK_PARAM が不足しています。docs/always-on/README.md を確認してください (#2294)。" >&2; \
	  exit 1; \
	fi
	$(CDK) deploy --app "$(ALWAYS_ON_RUNTIME_APP)" "$(ALWAYS_ON_RUNTIME_STACK)" $(APPROVAL)

synth-always-on-runtime: export CDK_SKIP_BUNDLING := 1
synth-always-on-runtime: ## Synthesize an event-scoped Always-On runtime | event単位のAlways-On runtimeをsynth
	$(CDK) synth --app "$(ALWAYS_ON_RUNTIME_APP)" "$(ALWAYS_ON_RUNTIME_STACK)" --quiet

archive-always-on-runtime: ## Archive runtime score events to S3 | runtime score eventをS3へarchive
	@set -eu; \
	function_name=$$(aws cloudformation describe-stacks \
	  --stack-name "$(ALWAYS_ON_RUNTIME_STACK)" \
	  --query "Stacks[0].Outputs[?OutputKey=='ArchiveFunctionName'].OutputValue | [0]" \
	  --output text); \
	if [ -z "$$function_name" ] || [ "$$function_name" = "None" ]; then \
	  echo "error: ArchiveFunctionName output が $(ALWAYS_ON_RUNTIME_STACK) にありません。" >&2; \
	  exit 1; \
	fi; \
	payload=$$(bun -e 'process.stdout.write(JSON.stringify({eventId: process.env.CDK_PARAM_ALWAYS_ON_EVENT_ID}))'); \
	response_file=$$(mktemp); \
	trap 'rm -f "$$response_file"' EXIT; \
	function_error=$$(aws lambda invoke \
	  --function-name "$$function_name" \
	  --cli-binary-format raw-in-base64-out \
	  --payload "$$payload" \
	  --query FunctionError \
	  --output text \
	  "$$response_file"); \
	cat "$$response_file"; \
	echo; \
	if [ "$$function_error" != "None" ]; then \
	  echo "error: raw score-event archive failed; runtime stack is kept for retry." >&2; \
	  exit 1; \
	fi

destroy-always-on-runtime: ## Delete an event-scoped Always-On runtime | event単位のAlways-On runtimeを削除
	@if [ -z "$${CDK_PARAM_ALWAYS_ON_EVENT_ID}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_TENANT_ID}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_EXPIRES_AT}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_DEPLOYMENTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_EVENTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_ENDPOINTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_CONTROL_PLANE_URL}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_ARCHIVE_BUCKET_NAME}" ]; then \
	  echo "error: destroy の app synth に必要な Always-On runtime CDK_PARAM が不足しています。" >&2; \
	  exit 1; \
	fi
	$(CDK) destroy --app "$(ALWAYS_ON_RUNTIME_APP)" "$(ALWAYS_ON_RUNTIME_STACK)" --force
