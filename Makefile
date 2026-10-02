.DEFAULT_GOAL := help
HELP_LANG ?= en
HELP_SCOPE ?= user
HELP_RENDERER := scripts/ops/make-help.awk

# ===== Help | ヘルプ =====
.PHONY: help

help: ## Show command help (HELP_LANG=ja for Japanese) | コマンド一覧を表示 (HELP_LANG=ja で日本語)
	@awk -v lang="$(HELP_LANG)" -v scope="$(HELP_SCOPE)" -f $(HELP_RENDERER) Makefile

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
# Bumps the problems/ pin to its tracked branch tip and leaves it STAGED for review. Run this to
# open the bump as its own PR (there is no scheduled workflow that does this automatically);
# pre-commit only checks that the checkout matches the staged pin; it never updates it.
submodule-latest: ## Update and stage the problem catalog submodule | 問題カタログsubmoduleを最新版へ更新してstage
	git submodule update --remote --recursive problems
	@git diff --quiet -- problems \
		&& echo "problems already at the latest pin." \
		|| { git add problems; echo "problems bumped + staged — review the submodule diff, then commit."; }
# How many workspaces `build` / `typecheck` run at once. 1 (serial, fail-fast, output in order)
# is the default a developer wants in a terminal; CI passes WORKSPACE_JOBS=4 because one
# `tsc --noEmit` uses a single core and the serial chain left three of the runner's four idle.
WORKSPACE_JOBS ?= 1

build: ## Build all retained applications and host (WORKSPACE_JOBS=n for parallel) | 継続する全アプリとhostをbuild
	bun run scripts/workspace/run-workspaces.ts build --jobs $(WORKSPACE_JOBS)
	bun run build:host
typecheck: ## Type-check every TypeScript workspace (WORKSPACE_JOBS=n for parallel) | 全workspaceのTypeScript型検査
	bun run typecheck:scripts
	bun run scripts/workspace/run-workspaces.ts typecheck --jobs $(WORKSPACE_JOBS)

# ===== Test | テスト =====
.PHONY: test test-coverage test-scripts

test: ## Run tests in every workspace | 全workspaceのテストを実行
	bun run test
test-coverage: ## Run all coverage shards sequentially | 全coverage shardを直列実行
	bun run test:coverage
test-scripts: ## Run retained script and authoring tests | 継続する script と問題作成機能を検証
	bun run test:root

# ===== Quality gates | 品質ゲート =====
.PHONY: audit-deps dup-check dup-baseline dead-code \
        submodule-not-behind before-commit ci-local

# 依存 package の lifecycle script 監査 (mini Shai-Hulud 2nd 対策)。
audit-deps: ## Audit dependency lifecycle-script changes | 依存packageのlifecycle script差分を監査
	bun run audit:dependencies

# jscpd ベースライン・ラチェット。 重複ゼロは強制しない (責務分離の意図的重複は baseline に焼き込み
# 済み)。 baseline を超える新しいコピペ / 再実装だけ fail させる。
dup-check: ## Fail when code duplication grows past the baseline | 重複がbaselineを超えたらfail
	bun run scripts/quality/check-duplication.ts
dup-baseline: ## Re-freeze the duplication baseline (justify increases in the PR) | 重複baselineを現状で更新
	bun run scripts/quality/check-duplication.ts --update

# knip デッドコードスキャン (#2866 でゲート化)。 検出の典型的な false positive は「新しい entrypoint
# が knip.json の workspace entry glob に無い」ケースで、 正しい修正は entry glob の追加 (gate の無効
# 化ではない)。 既知の盲点: root workspace は scripts/** を entry 扱いにしているため scripts/ 内の
# 未使用 export は検出対象外 (未使用 file は検出される)。
dead-code: ## Fail on unused files/exports found by knip | knipで未使用コード検出(ゲート)
	bun run dead-code

# problems/ の pin が後退した PR を落とす (gitlink ping-pong 対策)。CI も同じ実装を呼ぶ。
submodule-not-behind: ## Fail when the problems submodule pin moves backwards | problems pinの後退をfail
	bun run scripts/quality/check-submodule-not-behind.ts

# Pre-PR gate for the product BODY, run by the pre-commit hook.
GATE_CHECKS := lint dead-code test

before-commit: $(GATE_CHECKS) ## Run lint and all tests before committing | commit前のlintと全テストを実行

# `before-commit` は lint・dead-code・test を実行する。CI 全体の再現には ci-local を使う。
# (CI は audit-deps / submodule pin guard / build も走らせる)。`ci-local` は CI が走らせるものを
# CI と同じ順で全部走らせる (Codecov upload だけ除く)。
# Issue #2513: CI は同じ workspace 集合を 3 shard の matrix で並列に走らせる。ここでは 3 shard を
# 1 プロセスで直列に走らせる — 同じ検査・同じ workspace・意図的に違う並列度。
ci-local: ## Run the full GitHub Actions gate locally | GitHub Actions相当の全gateをローカル実行
	git fetch --no-tags origin main:refs/remotes/origin/main
	git -C problems fetch --tags --unshallow origin 2>/dev/null || git -C problems fetch --tags origin || true
	$(MAKE) audit-deps
	$(MAKE) dead-code
	$(MAKE) submodule-not-behind
	$(MAKE) validate-problems
	$(MAKE) lint-text
	$(MAKE) lint-format
	$(MAKE) lint-ts
	bun run test:root
	$(MAKE) typecheck
	$(MAKE) test-coverage
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
# (eslint.config.mjs の typedSourceFiles) が、 strict / stylistic / sonarjs は全 workspace に効く。
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
.PHONY: pack-init pack-validate pack-install pack-list

# Local pack tools retain their immutable snapshots. Host event catalog loading is separate.
PACK := bun run scripts/problem-pack/main.ts

pack-init: ## Scaffold a problem pack | 問題packの雛形を作成
	$(PACK) init $(ARGS)
pack-validate: ## Validate a problem pack manifest and assets | 問題packのmanifestとassetを検証
	$(PACK) validate $(ARGS)
pack-install: ## Install a problem pack into the local store | 問題packをlocal storeへinstall
	$(PACK) install $(ARGS)
pack-list: ## List installed problem packs | install済み問題packを一覧表示
	$(PACK) list $(ARGS)

# ===== Host candidate | host candidate =====
.PHONY: local down deploy destroy release-check release-candidate
local: ## Start the unified local competition console | ローカル競技コンソールを起動
	bun run scripts/local-host/local.ts start $(LOCAL_ARGS)
down: ## Stop owned local runtimes and preserve event data | 所有するローカル環境を停止し大会データを保持
	bun run scripts/local-host/local.ts down $(LOCAL_ARGS)
# Current checkout's Lambda/DynamoDB path. See infrastructure/README.md for supported
# problems, reviewed IAM setup, retained resources and the separate historical pipeline.
deploy: ## Deploy cloud hosting with reviewed AWS setup | 権限設定を確認してクラウド開催を配置
	bun run --no-env-file scripts/cloud-hosting/main.ts up $(CLOUD_ARGS)
destroy: ## Confirm and remove owned cloud resources; retain event data | 対象を確認してクラウドを撤収し大会データを保持
	bun run --no-env-file scripts/cloud-hosting/main.ts down $(CLOUD_ARGS)
release-check: ## Validate the unpublished host candidate contract | 未公開 host candidate の契約を検証
	bun run release:check
release-candidate: ## Record an already built image digest and source pins | build 済み image digest と source pin を記録
	bun run release:candidate $(ARGS)
form-setup: ## Configure the contact form backend | お問い合わせフォームを設定
	bun run form:setup $(FORM_SETUP_ARGS)

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
