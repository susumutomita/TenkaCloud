CDK      := cd infrastructure && JSII_DEPRECATED=quiet bun run cdk
APPROVAL := --require-approval broadening

# SBT 0.3.9 内部が aws-cdk-lib の deprecated な `advancedSecurityMode` 等を使っているため、
# cdk synth 時に大量の deprecation warning が出る。CFT 出力には影響しないので JSII_DEPRECATED=quiet
# で抑制する。SBT upstream が新 API (standardThreatProtectionMode) に移行したら外す。
export JSII_DEPRECATED := quiet

.DEFAULT_GOAL := help

.PHONY: help install install_ci submodule-latest build typecheck test test-coverage test-scripts clean-test-outdir audit-deps before-commit ci-local \
        lint lint-md lint-text lint-format \
        fix fix-md fix-text fix-format format \
        harness harness-test tech-debt \
        pack-init pack-validate pack-install pack-activate pack-deactivate pack-list \
        env-check env-check-lite env-init \
        deploy deploy-saas destroy destroy-saas \
        deploy-battles destroy-battles \
        deploy-always-on-ingress destroy-always-on-ingress synth-always-on-ingress \
        deploy-always-on-runtime archive-always-on-runtime destroy-always-on-runtime synth-always-on-runtime \
        dev synth check-synth \
        doctor local-onboard local local-up local-portal local-down local-status local-list local-evaluate

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
# Issue #2515: fast path for script/CLI-only changes (scripts/*.ts, infrastructure/test/scripts/*)
# that never touch CDK constructs — runs just that directory, skipping every other workspace and
# every CDK-synth test file. No architecture-invariant / coverage guarantee: it's a quick local
# sanity check before `make before-commit`, not a substitute for it.
test-scripts:  ; bun run --filter '@TenkaCloud/infrastructure' test test/scripts
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
# Issue #2513: CI runs this same workspace set as a 3-shard matrix (`coverage` job,
# infrastructure / spas / packages) via `scripts/run-coverage.ts --shard <name>` +
# `.claude/skills/quality-gates/scripts/check-coverage-gate.ts --shard <name>`, run in parallel
# with the `ci` job. `test-coverage` below (and `ci-local`, which chains it) instead runs all
# 3 shards serially in one process — same checks, same workspace set, intentionally different
# parallelism.
ci-local:
	git fetch --no-tags origin main:refs/remotes/origin/main
	git -C problems fetch --no-tags --unshallow origin 2>/dev/null || git -C problems fetch --no-tags origin || true
	$(MAKE) audit-deps
	bun run .claude/skills/quality-gates/scripts/run.ts submodule-not-behind
	$(MAKE) validate-problems
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

# ===== Problem catalog validation (#2254) =====
# Run the catalog authoring-contract validator (schema + the bilingual-README invariant from
# TenkaCloudChallenge #136: each problem dir must carry non-empty, non-symlink README.md +
# README.ja.md) against the platform's problems/ mirror. This makes a README-less / schema-invalid
# problem fail platform CI too — not only the catalog repo's own CI — closing the drift #2254 flags.
# problems/ is a git submodule (not a workspace member), so its own deps (ajv etc.) install here.
validate-problems:
	git submodule update --init problems
	cd problems && bun install --frozen-lockfile --ignore-scripts && bun run scripts/validate-problems.ts

# ===== Problem Packs (#2088, author-side CLI, Issue #2460) =====
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

pack-init:       ; $(PACK) init $(ARGS)
pack-validate:   ; $(PACK) validate $(ARGS)
pack-install:    ; $(PACK) install $(ARGS)
pack-activate:   ; $(PACK) activate $(ARGS)
pack-deactivate: ; $(PACK) deactivate $(ARGS)
pack-list:       ; $(PACK) list $(ARGS)

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
	bun run scripts/participant-portal-runtime-config.ts --cloud-mode mock
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
#   make local                     採点 API + Participant Portal を起動 (問題コンテナは必要時に起動)
#   make local PROBLEM=sqli-demo   問題コンテナを pre-start し、採点 API + Portal を起動
#   make local-up                  採点 API のみを起動 (上級者向け)
#   make local-portal              既存の採点 API に Participant Portal を接続
#   make local-down                コンテナ停止 + runtime-config 復元
#   make local-evaluate FLAG=...   採点 API 経由でフラグを提出 (= 問題コンテナ /verify に委譲)
#   TENKACLOUD_COMPOSE_CLI='docker-compose'  standalone compose を明示
# Issue #2119: `make local-onboard YES=1` pre-approves software installs (also for automation).
ONBOARD_FLAGS := $(if $(YES),--yes,)

# Issue #2119: report-only prerequisite diagnosis (mise trust / submodule / bun /
# Docker Compose / daemon). Installs nothing.
doctor:
	@command -v bun >/dev/null 2>&1 || { \
	  echo "Bun is required for diagnostics."; \
	  echo "  Install: (macOS) brew install oven-sh/bun/bun   (Linux) curl -fsSL https://bun.sh/install | bash"; \
	  exit 1; }
	@bun run scripts/tenkacloud-onboard.ts doctor

# Issue #2119: optional guided setup. This is the only local-play target that
# offers to trust mise, install Bun, initialize the problems/ submodule, or help
# with Docker setup. Keep `make local` itself lightweight and non-installing.
local-onboard:
	@sh scripts/onboard-bootstrap.sh $(ONBOARD_FLAGS)
	@bun run scripts/tenkacloud-onboard.ts preflight $(ONBOARD_FLAGS)

# Issue #2054 / #2392 / #2511: start the detached local scoring API, then the
# browser portal. `local-up` remains the API-only escape hatch for scripts.
local:
	@set -e; \
	problem="$(PROBLEM)"; \
	if bun run scripts/tenkacloud-local.ts status >/dev/null 2>&1; then \
	  if [ -n "$$problem" ]; then \
	    echo "Local play is already running; ignoring PROBLEM=$$problem. Run 'make local-down' first to restart with a pre-started problem."; \
	  else \
	    echo "Local play is already running; opening Participant Portal."; \
	  fi; \
	else \
	  if [ -n "$$problem" ]; then \
	    echo "Pre-starting PROBLEM=$$problem. Run 'make local-list' to see other local-play problems."; \
	  else \
	    echo "Starting local play. Problems start on demand from the browser portal."; \
	  fi; \
	  $(MAKE) local-up PROBLEM="$$problem" LOCAL_API_PORT="$(LOCAL_API_PORT)"; \
	fi; \
	$(MAKE) local-portal

local-up:
	@PROBLEM="$(PROBLEM)" LOCAL_API_PORT="$(LOCAL_API_PORT)" bun run scripts/tenkacloud-local.ts up "$(PROBLEM)"

local-portal:
	@bun run scripts/tenkacloud-local.ts status >/dev/null
	@( cd apps/participant-portal && bun run dev --host 127.0.0.1 )

local-down:
	@bun run scripts/tenkacloud-local.ts down

local-status:
	@bun run scripts/tenkacloud-local.ts status

# Issue #2188: list local-play problems (id / category / display name) for
# players who want to pre-start one by id.
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

# ===== Always-On ingress (ADR-049 Phase 4 / #2293) =====
# ADR-049 §8 "runtime スタックの手動デプロイ経路 (make target) を維持"。SLICE 1 で deploy 可能だが
# どの bin にも未配線だった IntentIngressStack を、専用 app (bin/tenkacloud-always-on.ts) 経由で
# operator が単体 deploy できる経路。ControlPlane / tenant pipeline / SBT を一切持ち込まないため、
# `make deploy` / `deploy-saas` / `deploy-battles` に対しては完全に NO-OP。
#
# 必須 env: CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM (= HS256 rollback 用 SSM SecureString 名) /
#           CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM (= ES256 公開 JWK を保持する SSM String 名) /
#           CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME / _ARN (= ProblemDeployBackend の CompetitorAccounts
#           DDB。 ingress が verified account を解決し、未検証 intent を fail-closed するために GetItem する。#2362) /
#           CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE (= audience pinning。未指定だと ingress は
#           fail-open で任意 audience の署名 intent を受理する。control plane の INTENT_AUDIENCE と一致必須。#2365)。
# 任意 env: CDK_PARAM_EVENT_BUS_ARN (既存 deploy bus へ re-emit。省略で local bus) /
#           CDK_PARAM_INTENT_INGRESS_ALLOWED_TENANT_IDS / _ALLOWED_EVENT_IDS (defense-in-depth)。
#
# 使い方:
#   make deploy-always-on-ingress \
#     CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM=/tenkacloud/intent-ingress/verify-secret \
#     CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM=/tenkacloud/intent-ingress/verify-public-jwk \
#     CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME=... CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN=...
ALWAYS_ON_INGRESS_APP := bunx tsx bin/tenkacloud-always-on.ts

deploy-always-on-ingress:
	@if [ -z "$${CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM}" ]; then \
	  echo "error: CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM が未指定 (= JWS 検証秘密を保持する SSM SecureString 名)。" >&2; \
	  echo "  例: make deploy-always-on-ingress CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM=/tenkacloud/intent-ingress/verify-secret" >&2; \
	  exit 1; \
	fi
	@if [ -z "$${CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM}" ]; then \
	  echo "error: CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM が未指定 (= ES256 公開 JWK を保持する SSM String 名)。" >&2; \
	  echo "  例: make deploy-always-on-ingress CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM=/tenkacloud/intent-ingress/verify-public-jwk" >&2; \
	  exit 1; \
	fi
	@if [ -z "$${CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN}" ]; then \
	  echo "error: CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME / _ARN が未指定 (= ingress の verified-account 解決に必須。#2362)。" >&2; \
	  exit 1; \
	fi
	@if [ -z "$${CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE}" ]; then \
	  echo "error: CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE が未指定 (= audience pinning。未指定は fail-open。#2365)。" >&2; \
	  exit 1; \
	fi
	$(CDK) deploy --app "$(ALWAYS_ON_INGRESS_APP)" --all $(APPROVAL)

# offline synth 検証 (Docker Lambda バンドルを skip する高速 shape チェック、check-synth と同じ思想)。
synth-always-on-ingress: export CDK_SKIP_BUNDLING := 1
synth-always-on-ingress:
	$(CDK) synth --app "$(ALWAYS_ON_INGRESS_APP)" --all --quiet

destroy-always-on-ingress:
	@if [ -z "$${CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM}" ]; then \
	  echo "error: CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM が未指定 (destroy も app synth のため必須)。" >&2; \
	  exit 1; \
	fi
	@if [ -z "$${CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM}" ]; then \
	  echo "error: CDK_PARAM_INTENT_INGRESS_VERIFY_PUBLIC_KEY_PARAM が未指定 (destroy も app synth のため必須)。" >&2; \
	  exit 1; \
	fi
	$(CDK) destroy --app "$(ALWAYS_ON_INGRESS_APP)" --all --force

# ===== Always-On per-event runtime (ADR-049 Phase 4 / #2363) =====
# ingress (上) は event 非依存の singleton。ここは event ごとに立て/畳む per-event runtime stack
# (bin/tenkacloud-always-on-runtime.ts)。stack id は tenkacloud-event-runtime-<eventId> で、
# deploy/destroy とも **その 1 stack のみ** を対象にする (`--all` は使わない = 他 event / ingress を
# 巻き込まない)。stack は runtime-tags (TenkaCloud:ManagedBy=always-on-runtime 他) を付与するので、
# 夜間 sweeper が期限切れ runtime を検出・削除できる。
#
# 必須 env: lifecycle 3 値に加え、runtime scoring が参照する既存 event-data table 名、
# Workers URL、SSM SecureString の score-feed token parameter 名。
ALWAYS_ON_RUNTIME_APP := bunx tsx bin/tenkacloud-always-on-runtime.ts
ALWAYS_ON_RUNTIME_STACK := tenkacloud-event-runtime-$(CDK_PARAM_ALWAYS_ON_EVENT_ID)

deploy-always-on-runtime:
	@if [ -z "$${CDK_PARAM_ALWAYS_ON_EVENT_ID}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_TENANT_ID}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_EXPIRES_AT}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_DEPLOYMENTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_EVENTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_ENDPOINTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_CONTROL_PLANE_URL}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_ARCHIVE_BUCKET_NAME}" ]; then \
	  echo "error: Always-On runtime lifecycle/scoring の必須 CDK_PARAM が不足しています。docs/always-on/README.md を確認してください (#2294)。" >&2; \
	  exit 1; \
	fi
	$(CDK) deploy --app "$(ALWAYS_ON_RUNTIME_APP)" "$(ALWAYS_ON_RUNTIME_STACK)" $(APPROVAL)

synth-always-on-runtime: export CDK_SKIP_BUNDLING := 1
synth-always-on-runtime:
	$(CDK) synth --app "$(ALWAYS_ON_RUNTIME_APP)" "$(ALWAYS_ON_RUNTIME_STACK)" --quiet

archive-always-on-runtime:
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

destroy-always-on-runtime:
	@if [ -z "$${CDK_PARAM_ALWAYS_ON_EVENT_ID}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_TENANT_ID}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_EXPIRES_AT}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_DEPLOYMENTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_EVENTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_ENDPOINTS_TABLE_NAME}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_CONTROL_PLANE_URL}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER}" ] || [ -z "$${CDK_PARAM_ALWAYS_ON_ARCHIVE_BUCKET_NAME}" ]; then \
	  echo "error: destroy の app synth に必要な Always-On runtime CDK_PARAM が不足しています。" >&2; \
	  exit 1; \
	fi
	$(CDK) destroy --app "$(ALWAYS_ON_RUNTIME_APP)" "$(ALWAYS_ON_RUNTIME_STACK)" --force
