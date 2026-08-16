# The infrastructure workspace also exports a `cdk` bin. Route every command
# through the shared resolver so neither that bin nor a global CLI can win.
REPO_CDK := cd infrastructure && JSII_DEPRECATED=quiet ../scripts/run-cdk.sh
APPROVAL := --require-approval broadening

# SBT 0.3.9 内部が aws-cdk-lib の deprecated な `advancedSecurityMode` 等を使っているため、
# cdk synth 時に大量の deprecation warning が出る。CFT 出力には影響しないので JSII_DEPRECATED=quiet
# で抑制する。SBT upstream が新 API (standardThreatProtectionMode) に移行したら外す。
export JSII_DEPRECATED := quiet

.DEFAULT_GOAL := help
HELP_LANG ?= en
HELP_RENDERER := scripts/ops/make-help.awk

# ===== Help | ヘルプ =====
.PHONY: help

help: ## Show command help (HELP_LANG=ja for Japanese) | コマンド一覧を表示 (HELP_LANG=ja で日本語)
	@awk -v lang="$(HELP_LANG)" -f $(HELP_RENDERER) Makefile

# ===== Setup / Build | セットアップ / ビルド =====
.PHONY: install install_ci submodule-latest build typecheck

install: ## Install development dependencies safely | 開発依存関係を安全設定でインストール
	# --ignore-scripts: defuse mini-shai-hulud 2nd wave (Flatt Tech, 2026-05-12).
	# bun does not honour npm_config_ignore_scripts or .npmrc's ignore-scripts,
	# so the flag is required on every invocation. Husky's `prepare` is skipped
	# along with everything else, so we re-bootstrap it explicitly afterwards.
	bun install --ignore-scripts
	bun x husky
install_ci: ## Install locked CI dependencies without lifecycle scripts | lockfile固定・script無効でCI依存関係をインストール
	bun install --frozen-lockfile --ignore-scripts
# Bumps the problems/ pin to its tracked branch tip and leaves it STAGED for review. The scheduled
# submodule-sync workflow does the same as its own PR; pre-commit only syncs the worktree to the pin.
submodule-latest: ## Update and stage the problem catalog submodule | 問題カタログsubmoduleを最新版へ更新してstage
	git submodule update --remote --recursive problems
	@git diff --quiet -- problems \
		&& echo "problems already at the latest pin." \
		|| { git add problems; echo "problems bumped + staged — review the submodule diff, then commit."; }
build: ## Build all applications and infrastructure | 全アプリとinfrastructureをbuild
	bun run build
typecheck: ## Type-check every TypeScript workspace | 全workspaceのTypeScript型検査
	bun run typecheck

# ===== Test | テスト =====
.PHONY: test test-root test-coverage test-scripts

test: ## Run tests in every workspace | 全workspaceのテストを実行
	bun run test
# The repo-root tests that live outside every workspace: the landing generators' --check mode and the
# seams under scripts/. CI's test surface is the coverage shards, which only ever enter a workspace,
# so without this target these run nowhere in CI. `make test` runs them first; this is the same list
# callable on its own.
test-root: ## Run the repo-root script tests only | repo直下のscript testだけを実行
	bun run test:root
test-coverage: ## Run all coverage shards sequentially | 全coverage shardを直列実行
	bun run test:coverage
# Issue #2515: fast path for script/CLI-only changes that never touch CDK constructs. No architecture
# or coverage guarantee — a local sanity check before `make before-commit`, not a substitute for it.
test-scripts: ## Run only the fast script and CLI tests | script・CLI関連テストだけを高速実行
	bun run --filter '@TenkaCloud/infrastructure' test test/scripts

# ===== Quality gates | 品質ゲート =====
.PHONY: harness harness-test tech-debt audit-deps dup-check dup-baseline \
        infra-coverage-check infra-coverage-baseline dead-code openapi openapi-check \
        before-commit ci-local

HARNESS := bun run .claude/harness/bin
harness: ## Check architecture invariants | architecture invariant違反を検査
	$(HARNESS)/architecture.ts --staged --fail-on=error
harness-test: ## Run the harness unit tests | harness自身のunit testを実行
	cd .claude/harness && bun vitest run
tech-debt: ## Generate the technical-debt backlog | tech debt backlogを生成
	$(HARNESS)/tech-debt.ts

# 依存 package の lifecycle script 監査 (mini Shai-Hulud 2nd 対策)。
audit-deps: ## Audit dependency lifecycle-script changes | 依存packageのlifecycle script差分を監査
	bun run audit:dependencies

# jscpd ベースライン・ラチェット。 重複ゼロは強制しない (責務分離の意図的重複は baseline に焼き込み
# 済み)。 baseline を超える新しいコピペ / 再実装だけ fail させる。
dup-check: ## Fail when code duplication grows past the baseline | 重複がbaselineを超えたらfail
	bun run scripts/quality/check-duplication.ts
dup-baseline: ## Re-freeze the duplication baseline (justify increases in the PR) | 重複baselineを現状で更新
	bun run scripts/quality/check-duplication.ts --update

# Issue #2758: infrastructure 全体はまだ 100% gate 対象外だが、AssumeRole/ExternalId・tenant
# isolation・deploy state machine・scoring・delete lifecycle・auth boundary
# (scripts/quality/infra-critical-paths.ts) は壊れると越境/不正スコアリングに直結するため、jscpd と
# 同じ baseline ratchet 方式で coverage の後退だけを検出する。 テストは再実行せず既存の
# infrastructure/coverage/lcov.info を読む。
infra-coverage-check: ## Fail when critical-path infra coverage drops below baseline | high-riskファイルのcoverage低下をfail
	bun run scripts/quality/check-infra-critical-coverage.ts
infra-coverage-baseline: ## Re-freeze the critical-path coverage baseline (justify decreases in the PR) | critical-path coverage baselineを現状で更新
	bun run scripts/quality/check-infra-critical-coverage.ts --update

# knip デッドコードスキャン (#2866 でゲート化)。 検出の典型的な false positive は「新しい entrypoint
# が knip.json の workspace entry glob に無い」ケースで、 正しい修正は entry glob の追加 (gate の無効
# 化ではない)。 既知の盲点: root workspace は scripts/** を entry 扱いにしているため scripts/ 内の
# 未使用 export は検出対象外 (未使用 file は検出される)。
dead-code: ## Fail on unused files/exports found by knip | knipで未使用コード検出(ゲート)
	bun run dead-code

# Issue #2949: machine API surface の spec は `MACHINE_ROUTE_SCOPES` と handler の zod schema から
# 生成する。手書きの path も schema も無いので、route を足して生成物を更新し忘れた PR は落ちる。
openapi: ## Generate the machine API OpenAPI spec | machine API の OpenAPI spec を生成
	bun run scripts/openapi/generate.ts
openapi-check: ## Fail when the committed OpenAPI spec drifts from the source of truth | OpenAPI 生成物の drift を検査
	bun run scripts/openapi/generate.ts --check

# Pre-PR gate for the product BODY, run by the pre-commit hook. HTTP magic number / template /
# coverage / IAM ASCII / merge / submodule の品質ゲートは本体と混ぜず .claude/skills/quality-gates
# へ分離してあり、pre-commit がこれとは別呼び出しで runner を走らせる。
GATE_CHECKS := harness openapi-check lint dead-code test

before-commit: $(GATE_CHECKS) ## Run lint and all tests before committing | commit前のlintと全テストを実行

# Issue #2219: `before-commit` は速い pre-push sanity check であって CI の完全な写しではない
# (CI は audit-deps / submodule pin guard / coverage-gate / build も走らせる)。`ci-local` は CI が
# 走らせるものを CI と同じ順で全部走らせる (Codecov upload だけ除く)。
# Issue #2513: CI は同じ workspace 集合を 3 shard の matrix で並列に走らせる。ここでは 3 shard を
# 1 プロセスで直列に走らせる — 同じ検査・同じ workspace・意図的に違う並列度。
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
.PHONY: lint lint-md lint-text lint-format lint-eslint-scope lint-ts lint-ts-prune \
        fix fix-md fix-text fix-format

lint: lint-md lint-text lint-format lint-eslint-scope lint-ts ## Check Markdown, prose, code formatting, and typed TS lint | Markdown・文章・code format・型付きTS lintを検査
fix: fix-md fix-text fix-format ## Fix all automatically repairable lint issues | lint可能な問題を一括修正

lint-md: ## Check Markdown conventions | Markdown規約を検査
	bun run lint:md
lint-text: ## Check Japanese and technical-writing conventions | 日本語・技術文章規約を検査
	bun run lint:text
lint-format: ## Check code formatting with Biome | Biomeでcode formatを検査
	bun run lint:format
# #3014: 対象は repo 全体 (`eslint .`)。 型情報を要する rule は `scripts/**` だけに効く
# (eslint.config.js の typedSourceFiles) が、 strict / stylistic / sonarjs は全 workspace に効く。
# 既存違反は `eslint-suppressions.json` に file × rule の件数として焼いてあり、 その件数以下なら緑、
# 1 件でも超えたら赤。
#
# 違反を直して件数が ceiling を下回ると ESLint は "There are suppressions left that do not occur
# anymore" で exit 2 になる。 これは失敗ではなく「ceiling を下げろ」という催促で、 `make
# lint-ts-prune` を実行して差分を commit するのが正しい応答 (= ratchet が下がる唯一の経路)。
# ceiling を手で編集しないこと。
#
# 並行 agent 運用では複数の branch が同時に prune して `eslint-suppressions.json` が衝突する。
# 解決はどちらかを選ぶのではなく、 merge 後の tree で `make lint-ts-prune` を流し直すこと。
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

# ===== Problem catalog validation | 問題カタログ検証 =====
.PHONY: validate-problems

# Runs the catalog authoring-contract validator (schema + the bilingual-README invariant) against the
# platform's problems/ mirror, so a README-less / schema-invalid problem fails platform CI too, not
# only the catalog repo's own CI (#2254). problems/ is a submodule, not a workspace member, so its
# own deps install here.
validate-problems: ## Validate problem schemas and bilingual READMEs | 問題catalogのschemaと日英READMEを検証
	git submodule update --init problems
	cd problems && bun install --frozen-lockfile --ignore-scripts && bun run scripts/validate-problems.ts

# ===== Problem Packs (author-side CLI) | 問題パック（作成者向けCLI） =====
.PHONY: pack-init pack-validate pack-install pack-activate pack-deactivate pack-list

# Thin delegation to the offline `pack` CLI. ARGS carries the subcommand's own positionals/flags
# verbatim — this Makefile never parses pack syntax itself. e.g.
#   make pack-install ARGS="git https://github.com/<you>/my-pack --commit <full-40hex-sha>"
# Full subcommand reference (incl. `inspect` / `remove`, not wrapped here):
# infrastructure/lib/problem-pack/pack-cli.ts
#
# CWD constraint: the CLI's default store (`.tenkacloud/pack-store`) resolves relative to the process
# CWD, and the Lite synth reads it from the REPO ROOT. So the CLI must run with CWD = repo root — do
# NOT switch this to a `cd infrastructure && bun run pack` form, or default-store installs land in
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

# ===== Release | リリース =====
.PHONY: release-report release-launcher-defaults release-check release-verify-published form-setup

release-report: ## Generate the human release report | 人間向けrelease reportを生成
	bun run release:report
release-launcher-defaults: ## Stamp launcher template literals from release/launcher-defaults.json | launcher literalをlauncher-defaults.jsonから生成
	bun run release:launcher-defaults
release-check: ## Validate the release manifest, generated report, launcher literals, and in-product BOM values | release manifest・生成report・launcher literal・製品コード内BOM値を検証
	bun run release:check
# Post-publication verification of a real GitHub Release (#3024). Reads only what a third
# party can download, so it needs no checkout of the tag. e.g. make release-verify-published TAG=v1.4.0
TAG ?=
release-verify-published: ## Verify a published GitHub Release end to end | 公開済みGitHub Releaseをend-to-endで検証
	@test -n "$(TAG)" || { echo "Usage: make release-verify-published TAG=v<major>.<minor>.<patch>" >&2; exit 1; }
	bun run release:verify-published -- --tag $(TAG)
# Options go through FORM_SETUP_ARGS; make would otherwise parse --repo itself.
# e.g. make form-setup FORM_SETUP_ARGS="--repo owner/name --skip-workflow"
FORM_SETUP_ARGS ?=
form-setup: ## Provision the Google Form backend end to end | お問い合わせフォームのGoogle側を一括構築
	bun run form:setup $(FORM_SETUP_ARGS)

# ===== CDK environment | CDK 環境設定 =====
.PHONY: env-check env-check-lite env-init

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
# Deploy uses a globally-unique, account-scoped source bucket — a fixed name collides across accounts
# (S3 bucket names are global). Compute it only when BOTH the account and a region are known,
# resolving the region as AWS_REGION -> AWS_DEFAULT_REGION to match prepare-source-bundle.sh's env
# order, so the name the script uploads to and the name cdk reads always agree. Otherwise keep a
# DNS-valid placeholder for `make synth` without creds (fromBucketName validates 3-63 lowercase
# chars); the script then resolves the region itself and computes the name.
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

# ===== Turso live verification | Turso live 検証 =====
.PHONY: turso-live turso-live-guide turso-live-preflight turso-live-verify-cfn turso-reset

# Issue #2617: Turso pure-SQL profile の初回 live E2E を 1 本の discoverable な導線へまとめる。
# guide は副作用なし、preflight / verify-cfn は AWS read-only。deploy は CLI 側で exact
# confirmation を要求し、destroy は意図的に内包しない。
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

# ===== Deploy / Destroy | デプロイ / 削除 =====
.PHONY: deploy deploy-saas destroy destroy-all destroy-saas enforce-log-retention

# Issue #955: デフォルトの make deploy は Lite (= single-tenant) mode。 大半の利用者は 1 人 1 大会の
# 主催で multi-tenant 抽象を必要としない。 Lite は Application Plane と Participant Portal を
# tenantId="local" 固定で立てる。 SaaS が必要なら `make deploy-saas`。
# `build` を必ず先に走らせる: 問題カタログは SPA build 時に `import.meta.glob` で
# problems/**/metadata.json を取り込むため、 submodule を最新化しても SPA を再 build しないと
# dist が古いカタログのまま deploy される。
deploy: env-check-lite build ## Deploy Lite mode to AWS | Lite modeをAWSへdeploy
	bun run scripts/tenkacloud-lite.ts up
# ref の install.sh 準拠の orchestration (= SaaS mode、 SBT ControlPlane を立てる):
#   1. S3 source bucket を作成 2. infrastructure/ を source.zip にして upload
#   3. cdk bootstrap + cdk deploy --all 4. client/client-template deploy (Admin/Application UI)
# CDK が construct 内部で singleton として作る provider Lambda (S3AutoDeleteObjects /
# AWSCDKOpenIdConnectProvider) は log 設定の prop を公開していないので、 その log group は無期限
# 保持のまま生まれる (#2960)。 deploy 直後に backstop を当てて拾う。
deploy-saas: env-check ## Deploy multi-tenant SaaS mode to AWS | multi-tenant SaaS modeをAWSへdeploy
	@cd scripts && bash install.sh "$${SYSTEM_ADMIN_EMAIL}"
	bash scripts/enforce-log-retention.sh

enforce-log-retention: env-check ## Fill in retention on tenkacloud log groups that have none | retention 未設定の log group に retention を当てる
	bash scripts/enforce-log-retention.sh

destroy: env-check-lite ## Delete Lite-mode AWS resources | Lite modeのAWS resourceを削除
	bun run scripts/tenkacloud-lite.ts down
destroy-all: env-check-lite ## Delete Lite stacks and retained data | Lite stackと保持データを完全削除
	bun run scripts/tenkacloud-lite.ts down --purge-retained-data
destroy-saas: env-check ## Delete SaaS-mode AWS resources | SaaS modeのAWS resourceを削除
	bash scripts/cleanup.sh

# ===== Synth (no deploy) | Synth（デプロイなし） =====
.PHONY: synth check-synth

#   - `synth`: full CFn synth (real Lambda bundling — slow, matches what `deploy` runs).
#   - `check-synth`: fast synth-only shape check (CDK_SKIP_BUNDLING=1 skips Docker Lambda bundling,
#     #1446) + the IAM Description ASCII gate (#664) that only sees synth output. This is the
#     offline infra-review step AGENTS.md points agents at for infra changes.
synth: ## Synthesize every CDK stack with bundling | 全CDK stackをbundle込みでsynth
	$(REPO_CDK) synth --quiet

check-synth: export CDK_SKIP_BUNDLING := 1
check-synth: ## Run fast CDK synth and the IAM ASCII check | 高速CDK synthとIAM ASCII検査を実行
	$(REPO_CDK) synth --quiet
	bun run .claude/skills/quality-gates/scripts/check-synth-iam-ascii.ts

# ===== Local dev (no AWS) | ローカル開発（AWS不要） =====
.PHONY: dev

# Starts all 3 SPA dev servers in parallel (admin-console :5173 / application-admin-console :5174 /
# participant-portal :5175). Ctrl-C stops all three (bun --parallel propagates SIGINT).
dev: ## Start all three SPA dev servers without AWS | 3つのSPA dev serverをAWSなしで起動
	bun run scripts/ops/participant-portal-runtime-config.ts --cloud-mode mock
	bun run --filter '@TenkaCloud/admin-console' --filter '@TenkaCloud/application-admin-console' --filter '@TenkaCloud/participant-portal' --parallel dev

# ===== Local play (Docker, no AWS) | ローカル演習（Docker、AWS不要） =====
.PHONY: doctor doctor-dev ensure-deps local-onboard local local-down local-status local-dev local-up \
        local-portal local-list local-evaluate local-reset local-snapshot-export \
        local-snapshot-import local-disrupt local-smoke local-measure

# Issue #2054: AWS 非依存の CTF コンテナ。 問題コンテナが `/verify` と採点条件を持ち、TenkaCloud は
# 採点 (participant API / portal / leaderboard / hint) だけを担う。
# Participant diagnosis intentionally has the same Docker-only host contract as `make local`.
# Issue #2909: `PROFILE=recommended` additionally compares Docker resources with the published
# measurements. `PROBE_DISK=1` opts in to the one non-read-only check (it pulls busybox to read the
# Docker VM's free space, which the host's own `df` cannot see on macOS).
DOCTOR_FLAGS := $(if $(PROFILE),--profile $(PROFILE),)$(if $(PROBE_DISK), --probe-disk,)
doctor: ## Diagnose Docker-only participant prerequisites | Dockerのみの参加者向け前提条件を診断
	@sh scripts/local/doctor.sh $(DOCTOR_FLAGS)

# Issue #2119: the original mise/submodule/Bun/Docker report belongs to the host Bun/Vite developer
# path. Keep it available without making Bun a participant prerequisite.
doctor-dev: ## Diagnose Bun/Vite developer prerequisites | Bun/Vite開発者向け前提条件を診断
	@command -v bun >/dev/null 2>&1 || { \
	  echo "Bun is required for developer diagnostics."; \
	  echo "  Install (macOS / Linux): bash scripts/onboard/install-bun.sh"; \
	  exit 1; }
	@bun run scripts/tenkacloud-onboard.ts doctor $(DOCTOR_FLAGS)

# Issue #2119: optional guided setup for the DEVELOPER Bun/Vite path (`make local-dev`). The
# participant path (`make local`) is Docker-only and needs none of this.
# `make local-onboard YES=1` pre-approves software installs (also for automation).
ONBOARD_FLAGS := $(if $(YES),--yes,)
local-onboard:
	@sh scripts/onboard/onboard-bootstrap.sh $(ONBOARD_FLAGS)
	@# The bootstrap may have JUST installed bun into ~/.bun/bin; this recipe line
	@# runs in a fresh shell whose PATH predates that install, so prefix it.
	@PATH="$$HOME/.bun/bin:$$PATH" bun run scripts/tenkacloud-onboard.ts preflight $(ONBOARD_FLAGS)

# Self-heal missing dependencies so `make local-dev` is a single entry point: on a fresh clone /
# Codespace that never ran `make install`, the portal's vite is absent. Issue #2907: this must run
# BEFORE any `bun run tenkacloud ...` — the CLI's static import graph pulls in external packages, so
# on a fresh clone module resolution fails before the CLI's own self-heal can execute.
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

# Issue #2906: the participant entry point. Docker Engine + Docker Compose v2 only — no Bun, Node, or
# node_modules on the host. See scripts/local/docker-launcher.sh and compose.local.yaml.
local: ## Start the local drill API and portal via Docker (participant path) | Docker でローカル問題演習を起動(参加者向け)
	@sh scripts/local/docker-launcher.sh up

local-down: ## Stop local play and clear all persisted progress | local playを停止して全進捗を消去
	@sh scripts/local/docker-launcher.sh down

local-status:
	@sh scripts/local/docker-launcher.sh status

# Issue #2054 / #2392 / #2511 / #2906: the DEVELOPER path — the same local-play engine, run directly
# on the host with Bun/Vite (hot reload, no container rebuild per change) instead of Docker. Run
# `make local-onboard` first on a fresh clone.
local-dev: ## Start local play on the host with Bun/Vite (developer path, hot reload) | ホストで Bun/Vite により起動(開発者向け・ホットリロード)
	@$(MAKE) ensure-deps
	@bun run tenkacloud local $(if $(PROBLEM),--problem "$(PROBLEM)",) $(if $(LOCAL_API_PORT),--api-port "$(LOCAL_API_PORT)",)

local-up:
	@$(MAKE) ensure-deps
	@bun run tenkacloud local up $(if $(PROBLEM),--problem "$(PROBLEM)",) $(if $(LOCAL_API_PORT),--api-port "$(LOCAL_API_PORT)",)

local-portal:
	@$(MAKE) ensure-deps
	@bun run tenkacloud local portal

# Issue #2188: list local-play problems (id / category / display name) for players who want to
# pre-start one by id.
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

# E2E smoke: start one local-play problem, assert every container reaches a healthy /
# one-shot-complete state, then tear it down. Catches a problem whose containers fail to start
# (broken compose, wrong image, an unhealthy service, or a full Docker VM disk). Defaults to a light
# single-container problem; override with PROBLEM=<id>.
local-smoke:
	@$(MAKE) ensure-deps
	@PROBLEM="$(PROBLEM)" bun run scripts/local-play/local-smoke.ts

# Issue #2909: re-runnable resource benchmark. Starts the profile's problems through the
# already-running local-play API, samples only TenkaCloud-owned containers, stops them, asserts they
# were reclaimed, and writes a record under docs/measurements/local-mode/. Requires `make local`
# to be running first. e.g. make local-measure PROFILE=minimum PROBLEMS=sqli-demo PHASE=warm
local-measure: ## Measure a local-mode resource profile and write a JSON record | ローカル動作要件を実測しJSONへ記録
	@$(MAKE) ensure-deps
	@PROFILE="$(PROFILE)" PROBLEMS="$(PROBLEMS)" PHASE="$(PHASE)" RELEASE="$(RELEASE)" \
	  HOST_DESCRIPTION="$(HOST_DESCRIPTION)" OUT="$(OUT)" \
	  bun run scripts/local/measure-profile.ts

# ===== Problem deploy smoke test | 問題デプロイのスモークテスト =====
.PHONY: deploy-battles destroy-battles

# 引数に問題フォルダを取り、順次 CFn deploy する開発者向け smoke test ツール。 SaaS 配線
# (Step Functions / EventBridge / tenant API / Cognito) を持ち込まず、 CFn template と AWS 権限の
# 正しさだけを確認する。 `BATTLES` は必須 (= default を持たない): 引数なしで叩いたときに silently
# deploy が始まる事故を防ぐため。
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

# ===== Symphony (self-hosted agent orchestration) | Symphony（自前エージェント統制） =====
.PHONY: agent-gate symphony-validate symphony-print symphony-run

# このリポジトリは自分の Symphony インスタンスだけを所有・実行する (.symphony/README.md)。
# 以前は GNUmakefile に分かれていたが、make が Makefile より先に GNUmakefile を読むため
# 「make の入口が 2 つある」状態になっていたのでこちらへ統合した。
SYMPHONY_BIN ?= symphony
SYMPHONY_WORKFLOW ?= .symphony/WORKFLOW.md
SYMPHONY_PORT ?= 4311
SYMPHONY_LOGS_ROOT ?= .symphony/logs

agent-gate: ci-local symphony-validate ## Run the full local gate plus the Symphony policy check | ci-localとSymphony policy検査をまとめて実行

symphony-validate: ## Assert the Symphony workflow keeps its safety policy | Symphony workflowの安全policyを検査
	@test -f "$(SYMPHONY_WORKFLOW)"
	@grep -q '^  kind: github$$' "$(SYMPHONY_WORKFLOW)"
	@grep -q '^    repo: susumutomita/TenkaCloud$$' "$(SYMPHONY_WORKFLOW)"
	@grep -q '^    - agent:ready$$' "$(SYMPHONY_WORKFLOW)"
	@grep -q 'make agent-gate' "$(SYMPHONY_WORKFLOW)"
	@grep -q 'codex exec review --base origin/main' "$(SYMPHONY_WORKFLOW)"
	@grep -q 'Never run deploy, destroy, release, force-push, or secret-management commands' "$(SYMPHONY_WORKFLOW)"

symphony-print: symphony-validate ## Print the validated Symphony workflow | 検査済みSymphony workflowを表示
	@cat "$(SYMPHONY_WORKFLOW)"

symphony-run: symphony-validate ## Start the repository-local Symphony instance | このrepo専用のSymphonyを起動
	@test -n "$$GITHUB_TOKEN" || { echo 'GITHUB_TOKEN is required' >&2; exit 2; }
	@test -n "$$SYMPHONY_WORKSPACE_ROOT" || { echo 'SYMPHONY_WORKSPACE_ROOT is required' >&2; exit 2; }
	@mkdir -p "$(SYMPHONY_LOGS_ROOT)"
	"$(SYMPHONY_BIN)" "$(SYMPHONY_WORKFLOW)" --port "$(SYMPHONY_PORT)" --logs-root "$(SYMPHONY_LOGS_ROOT)"
