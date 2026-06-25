CDK      := cd infrastructure && JSII_DEPRECATED=quiet bun run cdk
APPROVAL := --require-approval broadening

# SBT 0.3.9 内部が aws-cdk-lib の deprecated な `advancedSecurityMode` 等を使っているため、
# cdk synth 時に大量の deprecation warning が出る。CFT 出力には影響しないので JSII_DEPRECATED=quiet
# で抑制する。SBT upstream が新 API (standardThreatProtectionMode) に移行したら外す。
export JSII_DEPRECATED := quiet

.DEFAULT_GOAL := help

.PHONY: help install install_ci submodule-latest build typecheck test test-coverage clean-test-outdir check before-commit \
        oss-notices check-oss-notices audit-deps build-problems-index check-problems-index \
        cost-catalog check-cost-catalog \
        validate-problems verify-attacks \
        lint lint-md lint-text lint-format lint_md lint_text format_check \
        fix fix-md fix-text fix-format format \
        harness harness-test tech-debt \
        env-check env-check-lite env-init env-init-test synth check-synth diff bootstrap \
        deploy deploy-saas deploy-control-plane deploy-bootstrap destroy destroy-saas \
        deploy-docker destroy-docker docker-shell docker-build \
        deploy-battles destroy-battles \
        lite-up lite-down lite-status lite-portal-url lite-console-url \
        local-up local-serve local-open local-status local-evaluate local-down local dev dev-admin dev-app-admin dev-portal \
        ops-health ops-metrics

help:
	@awk '/^# =====/ {gsub(/^# ===== | =====$$/, ""); printf "\n%s\n", $$0} \
	      /^[a-z][a-zA-Z0-9_-]*:/ && !/^help:/ {sub(/:.*/, ""); printf "  %s\n", $$0}' Makefile

# ===== Setup / Build =====
install:
	# --ignore-scripts: defuse mini-shai-hulud 2nd wave (Flatt Tech, 2026-05-12).
	# bun does not honour npm_config_ignore_scripts or .npmrc's ignore-scripts,
	# so the flag is required on every invocation. Husky's `prepare` is skipped
	# along with everything else, so we re-bootstrap it explicitly afterwards.
	bun install --ignore-scripts
	bun x husky
install_ci:    ; bun install --frozen-lockfile --ignore-scripts
# Manual on-demand bump of the problems/ submodule to its tracked branch tip (.gitmodules branch=main).
# Leaves the bump *staged* for you to review + commit; the scheduled submodule-sync workflow does the
# same automatically as its own PR. Pre-commit only *syncs* the worktree to the pin, it never bumps.
submodule-latest:
	git submodule update --remote --recursive problems
	@git diff --quiet -- problems \
		&& echo "problems already at the latest pin." \
		|| { git add problems; echo "problems bumped + staged — review the submodule diff, then commit."; }
build:         ; bun run build
typecheck:     ; bun run typecheck
test:          ; bun run test
test-coverage: ; bun run test:coverage
# Issues #1295 / #1551: vitest setup pins CDK_OUTDIR to the repo-local
# infrastructure/cdk.out.test/<worker>. The package test wrapper purges it
# before and after normal runs; this target remains for interrupted processes.
clean-test-outdir: ; rm -rf infrastructure/cdk.out.test
validate-problems: ; bun run validate:problems
# Issue #1666: fire a problem's declared scoring.attackProbes at its local docker stack and
# assert each lands on the vulnerable baseline (red-team proof, no cloud account). On-demand
# (needs Docker, pulls images) — deliberately NOT in before-commit/check.
verify-attacks: ; bun run verify:attacks-local $(PROBLEM)
build-problems-index: ; bun run build:problems-index
check-problems-index: ; bun run check:problems-index
# Issue #1910 Slice 5: 問題ごとの使用 AWS リソース + 概算コストを GitHub 上に出すカタログ。
# submodule bump 由来の drift で CI を落とさないよう check は default gate に載せずオンデマンド再生成。
cost-catalog:       ; bun run scripts/build-cost-catalog.ts
check-cost-catalog: ; bun run scripts/build-cost-catalog.ts --check
oss-notices:   ; bun run oss-notices
check-oss-notices: ; bun run oss-notices:check
# 品質ゲート (HTTP magic number / template ASCII・security・cfn-refs・命名上限・CLI access /
# coverage 100% / synth IAM ASCII / merge 整合 / submodule pin) は本体と混ぜないため
# .claude/skills/quality-gates へ移設した。pre-commit フックと CI が runner を直接呼ぶ:
#   bun run .claude/skills/quality-gates/scripts/run.ts [--ci|--all|<name>...]
# AI 判断つきで走らせるときは /quality-gates スキルを使う。
audit-deps:    ; bun run audit:dependencies
# `check-problems-index` は submodule (= TenkaCloudChallenge) 側 catalog CI に責任を移譲した
# ため、 本体 before-commit / check からは外す。 platform 側 build:problems-index を走らせると
# catalog repo の biome JSON formatter (= 別 lock 版) と微妙な drift が出てしまうため、
# index.json の正本性は catalog 側で担保する設計。
# Shared pre-PR gate list for the product BODY only. `check` prepends `install`;
# `before-commit` assumes deps are present. Keep this single list authoritative so the two
# gates can never drift apart. 品質ゲート (HTTP magic number / template / coverage / IAM ASCII /
# merge / submodule) は本体と混ぜないため .claude/skills/quality-gates へ分離した。pre-commit
# フックが before-commit とは別呼び出しで runner を走らせ、CI は --ci グループを走らせる。
GATE_CHECKS := lint test validate-problems check-oss-notices audit-deps check-synth
check:         install $(GATE_CHECKS)
before-commit: $(GATE_CHECKS)

# `cdk synth` が通ることを保証 (= ts-node / tsx の module resolution、 stack 構築の type error
# 等を本番 deploy 前にキャッチ)。 Makefile placeholder env で全 stack を synth するので AWS 認証は不要。
#
# #1446 follow-up: 毎コミット (pre-commit) で走るこの gate は「synth の shape (module 解決 /
# 型 / construct ツリー / template 生成)」 を検証するのが目的で、 Lambda の実バンドルは不要。
# 実バンドル (SBT の Python CognitoAuth 等を Docker で pip install) は毎回 `cdk-<hash>` イメージを
# 生成し、 CDK はそれを掃除しないため Docker ディスクが青天井に膨らみ synth が ENOSPC で失敗していた。
# よって check-synth では `CDK_SKIP_BUNDLING=1` を渡し、 bin/infrastructure.ts 側で
# `aws:cdk:bundling-stacks=[]` を setContext して Docker バンドルを skip する
# (= module 解決 / 型 / construct の検証はそのまま、 Docker 不要・高速・イメージ非蓄積)。
# 実バンドルは `make synth` / `make deploy` 側で従来どおり行う (= env var 無しなら全 stack をバンドル)。
check-synth:
	@CDK_SKIP_BUNDLING=1 $(MAKE) synth >/dev/null 2>&1 || { echo "ERROR: cdk synth failed (= make deploy も失敗します)。 CDK_SKIP_BUNDLING=1 make synth で詳細を確認してください。"; exit 1; }
	@echo "OK  cdk synth (module 解決 / 型 / construct を検証、 Docker バンドルは skip — 実バンドルは make synth)"

# ===== Lint / Fix =====
lint:   lint-md lint-text lint-format
fix:    fix-md  fix-text  fix-format
format: fix

lint-md:     ; bun run lint:md
lint-text:   ; bun run lint:text
lint-format: ; bun run lint:format
fix-md:      ; bun run fix:md
fix-text:    ; bun run fix:text
fix-format:  ; bun run fix:format

# CI が参照するアンダースコア別名
lint_md:      lint-md
lint_text:    lint-text
format_check: lint-format

# ===== Harness =====
HARNESS := bun run .claude/harness/bin
harness:      ; $(HARNESS)/architecture.ts --staged --fail-on=error
harness-test: ; cd .claude/harness && bun vitest run
# Issue #1227: 全 tracked file を scan して assertion-roulette / high-coupling / magic-number
# を検出。 baseline 越え (= 新規違反) があれば exit 2 で落ちる。 既存違反は
# .claude/harness/baselines/tech-debt-*.json で凍結。 baseline を更新したいときは
#   bun run .claude/harness/bin/tech-debt.ts --baseline
tech-debt:    ; $(HARNESS)/tech-debt.ts

# ===== CDK =====
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

env-check:
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
env-check-lite:
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

# Issue #1345: Lite mode の first-run UX。 .env.example を読んで対話的に必須 3 vars
# (TENANT_ADMIN_EMAIL / AWS_REGION / CDK_PARAM_DEPLOY_EXTERNAL_ID) を埋め、
# infrastructure/environments/$(ENV)/.env を生成する。 既存 .env があれば skip。
env-init:
	@ENV=$(ENV) bun run scripts/env-init.ts

# Issue #1345: env-init.ts の shell-level integration test。 vitest 側 (= 純粋 logic)
# とは別に、 bun spawn → file I/O 経路が壊れていないかを確認する smoke。
env-init-test:
	@bash scripts/test-env-init.sh

synth:                build           ; $(CDK) synth
diff:                 build           ; $(CDK) diff --all
bootstrap:            env-check build ; $(CDK) bootstrap
# Issue #955: デフォルトの make deploy は Lite (= single-tenant) mode。
# 大半の利用者は 1 人 1 大会の主催で multi-tenant 抽象 (= SBT ControlPlane / tenant pipeline /
# tenant mapping table) を必要としない。 Lite mode は Application Plane (= Tenant Admin Console)
# と Participant Portal を `tenantId="local"` 固定で立てる (ADR-016)。
#   - Lite で deploy: tenkacloud-lite + tenkacloud-lite-problem-deploy
#   - SaaS が必要なら `make deploy-saas` (= 旧 default、 3-phase orchestration)
# `build` を必ず先に走らせる: 問題カタログは SPA build 時に `import.meta.glob` で
# `problems/**/metadata.json` を取り込む (apps/*/src/data/problems.ts) ため、 submodule を
# 最新化しても SPA を再 build しないと dist が古いカタログのまま deploy され、 新規問題が
# 取り込まれない。 bootstrap / deploy-control-plane 等の他 deploy 系と同じく build を prereq 化する。
deploy:               env-check-lite build ; bun run scripts/tenkacloud-lite.ts up
# ref の install.sh 準拠の orchestration (= SaaS mode、 SBT ControlPlane を立てる):
#   1. S3 source bucket (serverless-saas-${ACCOUNT_ID}-${REGION}) を作成
#   2. infrastructure/ を source.zip にして S3 に upload
#   3. cdk bootstrap + cdk deploy --all (ControlPlane + Bootstrap + Tenant-pooled)
#   4. client/client-template deploy (CloudFront + S3 for Admin/Application UI)
deploy-saas:          env-check
	@cd scripts && bash install.sh "$${SYSTEM_ADMIN_EMAIL}"
# stack 単位の deploy (直接呼ぶ時用。source.zip + CDK_PARAM_COMMIT_ID を事前 export しておく前提)
deploy-control-plane: env-check build ; $(CDK) deploy tenkacloud-control-plane $(APPROVAL)
deploy-bootstrap:     env-check build ; $(CDK) deploy tenkacloud-bootstrap $(APPROVAL)
destroy:              env-check-lite  ; bun run scripts/tenkacloud-lite.ts down
destroy-saas:         env-check       ; bash scripts/cleanup.sh

# ===== One-Docker deploy (host needs only Docker — no bun / node / aws-cli) =====
# exe.dev / fresh machines often lack bun. These targets run the normal deploy inside a
# toolchain container (Bun 1.3.11 + Node 24 + AWS CLI v2) defined by docker-compose.yml.
# They are pure `docker compose` (no bun on the host) so they work on a bun-less host.
# The repo is bind-mounted; ~/.aws is mounted read-only; env-var credentials also work.
#   make deploy-docker                 # Lite deploy in the container (ENV=development)
#   make deploy-docker ENV=production  # pick the target environment
#   make destroy-docker                # tear it down
#   make docker-shell                  # interactive shell in the toolchain image
#   make docker-build                  # rebuild the image after editing docker/Dockerfile
# Override DOCKER_COMPOSE=docker-compose for legacy Compose v1.
# DOCKER_USER passes the host uid/gid so the container drops root and repo writes (cdk.out)
# stay owned by the host user (see docker/entrypoint.sh).
DOCKER_COMPOSE ?= docker compose
DOCKER_USER = TENKACLOUD_UID=$(shell id -u) TENKACLOUD_GID=$(shell id -g)
deploy-docker:    ; $(DOCKER_USER) $(DOCKER_COMPOSE) run --rm tenkacloud make deploy ENV=$(ENV)
destroy-docker:   ; $(DOCKER_USER) $(DOCKER_COMPOSE) run --rm tenkacloud make destroy ENV=$(ENV)
docker-shell:     ; $(DOCKER_USER) $(DOCKER_COMPOSE) run --rm tenkacloud bash
docker-build:     ; $(DOCKER_COMPOSE) build tenkacloud

# ===== Problem deploy smoke test =====
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

deploy-battles:
	@if [ -z "$(BATTLES)" ]; then \
	  echo "error: BATTLES が未指定。例: make deploy-battles BATTLES=\"problems/battles/security-battle-royale\"" >&2; \
	  exit 1; \
	fi
	@TEAM_SLUG="$(TEAM_SLUG)" bash scripts/deploy-battles.sh $(BATTLES)
destroy-battles:
	@if [ -z "$(BATTLES)" ]; then \
	  echo "error: BATTLES が未指定。例: make destroy-battles BATTLES=\"problems/battles/security-battle-royale\"" >&2; \
	  exit 1; \
	fi
	@TEAM_SLUG="$(TEAM_SLUG)" bash scripts/destroy-battles.sh $(BATTLES)

# ===== TenkaCloud Lite mode (AWS, single tenant) =====
# 「OSS / Product Hunt 向けに 1 コマンドで TenkaCloud を試す」体験を提供する CLI wrapper。
# Lite stack は tenantId=local 固定で SBT / Pipeline / 動的 tenant 作成を持ち込まない (= ADR-016)。
# 実 deploy 経路は Phase 5 で追加する `infrastructure/bin/tenkacloud-lite.ts` (= 専用 bin entry)
# と組み合わせて完成する。 本ターゲットは CLI runner を委譲するのみ。
lite-up:           ; bun run scripts/tenkacloud-lite.ts up
lite-down:         ; bun run scripts/tenkacloud-lite.ts down
lite-status:       ; bun run scripts/tenkacloud-lite.ts status
lite-portal-url:   ; bun run scripts/tenkacloud-lite.ts portal-url
lite-console-url:  ; bun run scripts/tenkacloud-lite.ts console-url

# ===== Local development (no AWS) =====
# Issue #1975: `tenkacloud local` runs only the Participant Portal against a local node:http
# backend (no AWS / Cognito / SBT). Distinct from lite-* (AWS deploy).
LOCAL_CLI = bun run apps/cli/bin/tenkacloud.ts local

local-up:       ; $(LOCAL_CLI) up $(PROBLEM)
local-serve:    ; $(LOCAL_CLI) serve
local-open:     ; $(LOCAL_CLI) open
local-status:   ; $(LOCAL_CLI) status
local-evaluate: ; $(LOCAL_CLI) evaluate $(PROBLEM) $(FLAG)
local-down:     ; $(LOCAL_CLI) down
# Combined: start the local API, then the participant-portal dev server (foreground).
local: local-up
	cd apps/participant-portal && bun run dev
# Start all 3 SPA dev servers in parallel (admin :5173 / app-admin :5174 / portal :5175).
dev:
	$(MAKE) -j3 dev-admin dev-app-admin dev-portal
dev-admin:     ; cd apps/admin-console && bun run dev
dev-app-admin: ; cd apps/application-admin-console && bun run dev
dev-portal:    ; cd apps/participant-portal && bun run dev

# ===== Ops observation (read-only CLI for AI / operator) =====
# Issue #952: AI 無人運用の足場。 全 TenkaCloud stack の状態を 1 コマンドで観察する
# read-only CLI。 exit code は 0=全 healthy / 1=in_progress あり / 2=failed あり。
# 外部 cron / AI agent が spawn して platform 状態を判断する経路。
ops-health:        ; bun run scripts/tenkacloud-ops.ts health

# Issue #2018: Lite イベント・リハーサルのメトリクス自動集計 (read-only)。 Deployments table を
# scan し status 内訳 / deploy 成功率 / deploy 所要時間 / 初回 deploy wall-clock を出す。
# TABLE は必須 (= Deployments table 名、 make lite-status / CFn outputs から確認)。
ops-metrics:       ; bun run scripts/tenkacloud-ops.ts metrics --table $(TABLE)$(if $(REGION), --region $(REGION),)
