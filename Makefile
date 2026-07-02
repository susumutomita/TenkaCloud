CDK      := cd infrastructure && JSII_DEPRECATED=quiet bun run cdk
APPROVAL := --require-approval broadening

# SBT 0.3.9 内部が aws-cdk-lib の deprecated な `advancedSecurityMode` 等を使っているため、
# cdk synth 時に大量の deprecation warning が出る。CFT 出力には影響しないので JSII_DEPRECATED=quiet
# で抑制する。SBT upstream が新 API (standardThreatProtectionMode) に移行したら外す。
export JSII_DEPRECATED := quiet

.DEFAULT_GOAL := help

.PHONY: help install install_ci submodule-latest build typecheck test test-coverage clean-test-outdir audit-deps before-commit ci-local \
        lint lint-md lint-text lint-format \
        fix fix-md fix-text fix-format format \
        harness harness-test tech-debt \
        env-check env-check-lite env-init \
        deploy deploy-saas destroy destroy-saas \
        deploy-battles destroy-battles \
        dev synth check-synth \
        doctor local local-up local-down local-status local-list local-evaluate

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
# 依存パッケージの lifecycle script 監査 (mini Shai-Hulud 2nd 対策)。 CI が走らせる。
audit-deps:    ; bun run audit:dependencies
# Pre-PR gate for the product BODY, run by the pre-commit hook. 品質ゲート (HTTP magic number /
# template / coverage / IAM ASCII / merge / submodule) は本体と混ぜないため
# .claude/skills/quality-gates へ分離済み — pre-commit フックが before-commit とは別呼び出しで
# runner を走らせ、CI は --ci グループを走らせる。
GATE_CHECKS := lint test

before-commit: $(GATE_CHECKS)

# Issue #2219: `before-commit` (lint + test) is a fast pre-push sanity check, not a full CI
# mirror — CI (.github/workflows/ci.yml) additionally runs audit-deps / the submodule pin
# guard / coverage-gate (100% for agent-owned workspaces) / build, so a green `before-commit`
# does not guarantee a green CI. `ci-local` runs everything CI runs, in CI's own order, minus
# the Codecov upload step (network + secret, not meaningful to run locally).
ci-local:
	git fetch --no-tags origin main:refs/remotes/origin/main
	git -C problems fetch --no-tags --unshallow origin 2>/dev/null || git -C problems fetch --no-tags origin || true
	$(MAKE) audit-deps
	bun run .claude/skills/quality-gates/scripts/run.ts submodule-not-behind
	$(MAKE) lint-text
	$(MAKE) lint-format
	$(MAKE) typecheck
	$(MAKE) test-coverage
	bun run .claude/skills/quality-gates/scripts/run.ts coverage-gate
	$(MAKE) build

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

# ===== Harness =====
HARNESS := bun run .claude/harness/bin
harness:      ; $(HARNESS)/architecture.ts --staged --fail-on=error
harness-test: ; cd .claude/harness && bun vitest run
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
deploy:               env-check-lite build ; bun run scripts/tenkacloud-lite.ts up
# ref の install.sh 準拠の orchestration (= SaaS mode、 SBT ControlPlane を立てる):
#   1. S3 source bucket (serverless-saas-${ACCOUNT_ID}-${REGION}) を作成
#   2. infrastructure/ を source.zip にして S3 に upload
#   3. cdk bootstrap + cdk deploy --all (ControlPlane + Bootstrap + Tenant-pooled)
#   4. client/client-template deploy (CloudFront + S3 for Admin/Application UI)
deploy-saas:          env-check
	@cd scripts && bash install.sh "$${SYSTEM_ADMIN_EMAIL}"

destroy:              env-check-lite  ; bun run scripts/tenkacloud-lite.ts down
destroy-saas:         env-check       ; bash scripts/cleanup.sh

# ===== Local dev (no AWS) =====
# Issue #2228: AGENTS.md "SPA dev servers" documented this target before it existed.
# Starts all 3 SPA dev servers in parallel (admin-console :5173 / application-admin-console
# :5174 / participant-portal :5175). Ctrl-C stops all three (bun --parallel propagates SIGINT).
dev:
	bun run --filter '@TenkaCloud/admin-console' --filter '@TenkaCloud/application-admin-console' --filter '@TenkaCloud/participant-portal' --parallel dev

# ===== Synth (no deploy) =====
# Issue #2228: AGENTS.md / infrastructure/bin/infrastructure.ts referenced `make check-synth`
# and `make synth` as the offline infra-review gate before either existed.
#   - `synth`: full CFn synth (real Lambda bundling — slow, matches what `deploy` runs).
#   - `check-synth`: fast synth-only shape check (CDK_SKIP_BUNDLING=1 skips Docker Lambda
#     bundling, #1446) + the IAM Description ASCII gate (#664) that only sees synth output.
#     This is the "infra changes carry extra care" verification step AGENTS.md's Role
#     split section points agents at.
synth:
	$(CDK) synth --all --quiet

check-synth: export CDK_SKIP_BUNDLING := 1
check-synth:
	$(CDK) synth --all --quiet
	bun run .claude/skills/quality-gates/scripts/check-synth-iam-ascii.ts

# ===== Local play (Docker, no AWS) =====
# Issue #2054: AWS 非依存の CTF コンテナ。 問題コンテナが `/verify` と採点条件を持ち、
# TenkaCloud は採点 (participant API / portal / leaderboard / hint) だけを担う。 Kumo は撤去。
#   make local PROBLEM=sqli-demo   問題コンテナ + 採点 API を起動し Participant Portal を立ち上げる
#   make local-down                コンテナ停止 + runtime-config 復元
#   make local-evaluate FLAG=...   採点 API 経由でフラグを提出 (= 問題コンテナ /verify に委譲)
PROBLEM ?= sqli-demo
# Issue #2119: `make local YES=1` pre-approves software installs (also for automation).
ONBOARD_FLAGS := $(if $(YES),--yes,)

# Issue #2119: report-only prerequisite diagnosis (mise trust / submodule / bun /
# Docker CLI / Compose / daemon). Installs nothing.
doctor:
	@command -v bun >/dev/null 2>&1 || { \
	  echo "Bun is required for diagnostics."; \
	  echo "  Install: (macOS) brew install oven-sh/bun/bun   (Linux) curl -fsSL https://bun.sh/install | bash"; \
	  exit 1; }
	@bun run scripts/tenkacloud-onboard.ts doctor

# Issue #2119: a fresh `git clone` → `make local` reaches a running portal.
# Step 1 (pre-bun): trust mise + ensure bun is installed (consent-gated).
# Step 2 (bun onboarder): initialize the problems/ submodule + diagnose Docker,
#   installing only with consent (or YES=1); a non-interactive run without YES=1
#   stops with the missing prerequisites instead of installing.
# Step 3: start the problem container + scoring API, then the Participant Portal.
local:
	@sh scripts/onboard-bootstrap.sh $(ONBOARD_FLAGS)
	@bun run scripts/tenkacloud-onboard.ts preflight $(ONBOARD_FLAGS)
	@echo "Playing PROBLEM=$(PROBLEM). Run 'make local-list' to see other local-play problems."
	@set -e; \
	$(MAKE) local-up PROBLEM="$(PROBLEM)" LOCAL_API_PORT="$(LOCAL_API_PORT)"; \
	trap '$(MAKE) local-down' EXIT INT TERM; \
	cd apps/participant-portal && bun run dev --host 127.0.0.1

local-up:
	@PROBLEM="$(PROBLEM)" LOCAL_API_PORT="$(LOCAL_API_PORT)" bun run scripts/tenkacloud-local.ts up "$(PROBLEM)"

local-down:
	@bun run scripts/tenkacloud-local.ts down

local-status:
	@bun run scripts/tenkacloud-local.ts status

# Issue #2188: list local-play problems (id / category / display name) so
# players can pick one instead of already needing to know its id.
local-list:
	@bun run scripts/tenkacloud-local.ts list

local-evaluate:
	@if [ -z "$(FLAG)" ]; then \
	  echo "error: FLAG is required. Example: make local-evaluate FLAG='TC{...}'" >&2; \
	  exit 1; \
	fi
	@bun run scripts/tenkacloud-local.ts evaluate "$(FLAG)"

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
