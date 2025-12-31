.PHONY: help install install_ci setup_husky clean lint lint_text format format_check before_commit before-commit start test test_quick test_coverage test_e2e test_e2e_ui test_e2e_headed dev build
.PHONY: start-compose stop-compose stop restart status
.PHONY: start-infrastructure start-infrastructure-bg start-dev-servers start-control-plane stop-infrastructure stop-control-plane restart-all
.PHONY: check-docker check-docker-hub docker-build docker-run docker-stop docker-status
.PHONY: start-local stop-local logs-local test-lambda test-tenant
.PHONY: auth0-check-tfvars auth0-init auth0-plan auth0-apply auth0-output auth0-setup

# デフォルトターゲットはhelp
default: help

# ni: パッケージマネージャー自動選択ツール（bun.lockb を検出して bun を使用）
# proto の shim が Sandbox 環境でクラッシュすることがあるため、直接 bin パスを優先
PROTO_BIN := $(HOME)/.proto/bin
ifeq ($(wildcard $(PROTO_BIN)/bun),$(PROTO_BIN)/bun)
	BUN ?= $(PROTO_BIN)/bun
	BUNX ?= $(PROTO_BIN)/bunx
else
	BUN ?= bun
	BUNX ?= bunx
endif

# shims が優先される PATH を上書きし、直接 bin を使う
export PATH := $(PROTO_BIN):$(PATH)

# NI  = bunx ni   (依存関係インストール = bun install 相当)
# NR  = bunx nr   (スクリプト実行 = bun run 相当)
# NLX = bunx nlx  (パッケージ一時実行 = bunx 相当)
NI ?= $(BUNX) ni
NR ?= $(BUNX) nr
NLX ?= $(BUNX) nlx
APPS_DIR := apps
CONTROL_PLANE_DIR := $(APPS_DIR)/control-plane
APPLICATION_PLANE_DIR := $(APPS_DIR)/application-plane
FRONTEND_APPS := $(CONTROL_PLANE_DIR) $(APPLICATION_PLANE_DIR)
PACKAGES_DIR := packages
CORE_PACKAGE_DIR := $(PACKAGES_DIR)/core
SHARED_PACKAGE_DIR := $(PACKAGES_DIR)/shared

# ========================================
# 📦 パッケージ管理
# ========================================

# Note: lint_text/format_check は CI で ni インストール前に実行されるため、直接 bun を使用
lint_text:
	$(BUN) run lint_text

format_check:
	$(BUN) run format_check

install:
	$(NI)
	@for app in $(FRONTEND_APPS); do \
		echo "📦 $$app の依存関係をインストール中..."; \
		(cd $$app && $(NI)) || exit 1; \
	done
	@echo "✅ すべてのフロントエンドアプリの依存関係をインストールしました"

# Supply Chain Security: Disable lifecycle scripts during install
# Note: install_ci は ni インストール前に実行されるため、直接 bun を使用
install_ci:
	$(BUN) run install:ci
	@for app in $(FRONTEND_APPS); do \
		echo "📦 $$app の依存関係をインストール中（CI）..."; \
		(cd $$app && $(BUN) install --frozen-lockfile --ignore-scripts) || exit 1; \
	done
	@echo "✅ すべての依存関係をインストールしました（CI）"

setup_husky:
	$(BUN) run husky

clean:
	$(NR) clean || true

# ========================================
# 🔍 コード品質
# ========================================

lint:
	@echo "🔍 全フロントエンドアプリの lint を実行中..."
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📋 $$app の lint..."; \
		(cd $$app && $(NR) lint) || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリの lint が成功しました"

format:
	$(NR) format

typecheck:
	@echo "🔍 全フロントエンドアプリの型チェックを実行中..."
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📋 $$app の型チェック..."; \
		(cd $$app && $(NR) typecheck) || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリの型チェックが成功しました"

# ========================================
# 🏗  ビルド
# ========================================

build:
ifeq ($(SKIP_FRONTEND_BUILD),1)
	@echo "⚠️  SKIP_FRONTEND_BUILD=1 が設定されているため build をスキップします"
else
	@echo "🏗  全フロントエンドアプリをビルド中..."
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📦 $$app をビルド中..."; \
		(cd $$app && NEXT_TELEMETRY_DISABLED=1 SKIP_AUTH0_VALIDATION=1 AUTH0_CLIENT_ID=dummy-client-id AUTH0_CLIENT_SECRET=dummy-client-secret AUTH0_ISSUER=https://example.com $(NR) build) || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリのビルドが成功しました"
endif

dev:
	cd $(CONTROL_PLANE_DIR) && $(NR) dev

dev-app:
	cd $(APPLICATION_PLANE_DIR) && $(NR) dev

# ========================================
# 🧪 テスト
# ========================================

# デフォルトのテストはカバレッジ付き
test: test_coverage

# カバレッジなしの高速テスト
test_quick:
	@echo "🧪 全アプリのテストを実行中（カバレッジなし）..."
	@echo ""
	@echo "📦 フロントエンドアプリ:"
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "🔬 $$app のテスト..."; \
		(cd $$app && $(NR) test) || exit 1; \
	done
	@echo ""
	@echo ""
	@echo "✅ すべてのテストが成功しました"

test_coverage:
	@echo "📊 全アプリのカバレッジテストを実行中..."
	@echo ""
	@echo "📦 アプリ:"
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📈 $$app のカバレッジテスト..."; \
		(cd $$app && $(NR) test:coverage) || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのカバレッジテストが成功しました"

# E2E テスト（Playwright）
test_e2e:
	@echo "🎭 E2E テストを実行中..."
	@cd $(CONTROL_PLANE_DIR) && $(NLX) playwright install chromium --with-deps
	@cd $(CONTROL_PLANE_DIR) && $(NR) test:e2e
	@echo "✅ E2E テストが成功しました"

test_e2e_ui:
	@echo "🎭 E2E テストを UI モードで実行中..."
	@cd $(CONTROL_PLANE_DIR) && $(NLX) playwright install chromium --with-deps
	@cd $(CONTROL_PLANE_DIR) && $(NR) test:e2e:ui

test_e2e_headed:
	@echo "🎭 E2E テストを headed モードで実行中..."
	@cd $(CONTROL_PLANE_DIR) && $(NLX) playwright install chromium --with-deps
	@cd $(CONTROL_PLANE_DIR) && $(NR) test:e2e:headed

before_commit: lint_text format_check typecheck test_coverage build
	@echo "✅ すべてのコミット前チェックが完了しました"

before-commit: before_commit

# ========================================
# 🐳 Docker チェック
# ========================================

check-docker:
	@echo "🔍 Docker の起動状態を確認しています..."
	@docker --version > /dev/null 2>&1 || (echo "❌ Docker がインストールされていません" && exit 1)
	@docker ps > /dev/null 2>&1 || (echo "❌ Docker が起動していません。Docker Desktop を起動してください。" && exit 1)
	@echo "✅ Docker は起動しています"

check-docker-hub:
	@echo "🔍 Docker Hub への接続を確認しています..."
	@for i in 1 2 3; do \
		if curl -s -o /dev/null -w "" --connect-timeout 5 https://auth.docker.io/token 2>/dev/null; then \
			echo "✅ Docker Hub に接続できます"; \
			exit 0; \
		fi; \
		echo "   試行 $$i/3 - Docker Hub への接続を再試行中..."; \
		sleep 2; \
	done; \
	echo "❌ Docker Hub に接続できません。ネットワーク接続を確認してください。"; \
	echo ""; \
	echo "📋 対処方法:"; \
	echo "  1. インターネット接続を確認"; \
	echo "  2. VPN を使用している場合は一時的に無効化"; \
	echo "  3. DNS 設定を確認（8.8.8.8 など）"; \
	echo "  4. 数分待ってから再試行"; \
	exit 1

# ========================================
# 🚀 起動・停止（統合コマンド）
# ========================================

# make start: LocalStack + フロントエンド開発サーバーをすべて起動
start: start-infrastructure-bg start-dev-servers

# make start-infrastructure: LocalStack のみ起動（バックグラウンド）
start-infrastructure: start-local

# バックグラウンドで LocalStack を起動し、準備完了を待つ
start-infrastructure-bg: check-docker check-aws-cli check-terraform
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🚀 TenkaCloud を起動します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@./scripts/local-setup.sh

# フロントエンド開発サーバーを起動
start-dev-servers:
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🖥️  フロントエンド開発サーバーを起動します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Control Plane:      http://localhost:13000"
	@echo "  - Application Plane:  http://localhost:13001"
	@echo "  - LocalStack:         http://localhost:4566"
	@echo ""
	@echo "💡 終了するには Ctrl+C を押してください"
	@echo ""
	@$(NR) dev

# make stop: LocalStack を停止
stop: stop-local

restart:
	@echo "♻️  TenkaCloud を再起動します..."
	@$(MAKE) stop
	@$(MAKE) start

status:
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📊 TenkaCloud サービス状態"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "🐳 Docker Compose:"
	@docker compose ps 2>/dev/null || echo "  ❌ 起動していません"
	@echo ""
	@echo "🔧 LocalStack サービス:"
	@curl -s http://localhost:4566/_localstack/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  ❌ LocalStack が起動していません"
	@echo ""

# ========================================
# 🐳 Docker Compose（ローカル開発）
# ========================================

start-compose: check-docker
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🐳 Docker Compose で TenkaCloud を起動します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@docker compose up -d --build
	@echo "⏳ DynamoDB Local の起動を待っています..."
	@bash -c 'for i in {1..15}; do \
		if curl -s -f http://localhost:8000 > /dev/null 2>&1; then \
			echo "✅ DynamoDB Local が起動しました"; \
			break; \
		fi; \
		echo "   試行 $$i/15..."; \
		sleep 2; \
	done'
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✨ 全サービスの起動が完了しました！"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Control Plane:      http://localhost:13000"
	@echo "  - Application Plane:  http://localhost:13001"
	@echo "  - DynamoDB Local:     http://localhost:8000"
	@echo ""
	@echo "💡 Auth0 認証を使用するには .env.local で環境変数を設定してください"
	@echo ""

stop-compose:
	@echo "🛑 Docker Compose サービスを停止しています..."
	@docker compose down
	@echo "✅ 停止しました"

# 後方互換性
start-all: start-compose
stop-all: stop-compose
restart-all: stop-compose start-compose

# ========================================
# 🏢 インフラストラクチャ管理（従来版・互換性）
# ========================================

start-infrastructure: check-docker
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🚀 TenkaCloud インフラストラクチャを起動します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📦 ステップ 1/2: DynamoDB Local を起動しています..."
	@docker compose up -d dynamodb-local
	@echo "⏳ DynamoDB Local の起動を待っています..."
	@bash -c 'for i in {1..15}; do \
		if curl -s -f http://localhost:8000 > /dev/null 2>&1; then \
			echo "✅ DynamoDB Local が起動しました"; \
			break; \
		fi; \
		echo "   試行 $$i/15..."; \
		sleep 2; \
	done'
	@echo ""
	@echo "📝 ステップ 2/2: 環境変数ファイルを確認しています..."
	@if [ ! -f $(CONTROL_PLANE_DIR)/.env.local ]; then \
		echo "⚠️  .env.local が見つかりません。.env.example からコピーしています..."; \
		cd $(CONTROL_PLANE_DIR) && cp .env.example .env.local; \
		echo ""; \
		echo "⚠️  重要: $(CONTROL_PLANE_DIR)/.env.local を編集して以下を設定してください:"; \
		echo "  - AUTH_SECRET (openssl rand -base64 32 で生成)"; \
		echo "  - AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET / AUTH0_ISSUER"; \
	else \
		echo "✅ .env.local が存在します"; \
	fi
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✨ インフラストラクチャの起動が完了しました！"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - DynamoDB Local:   http://localhost:8000"
	@echo ""

stop-infrastructure:
	@echo "🛑 TenkaCloud インフラストラクチャを停止しています..."
	@docker compose down dynamodb-local 2>/dev/null || docker compose stop dynamodb-local
	@echo "✅ インフラストラクチャを停止しました"

start-control-plane:
	@echo "🚀 Control Plane を起動します..."
	cd $(CONTROL_PLANE_DIR) && $(NR) dev

stop-control-plane:
	@echo "🛑 Control Plane UI を停止しています..."
	@docker compose stop control-plane-ui || true
	@echo "✅ Control Plane UI を停止しました"

setup-dynamodb: check-docker
	@echo "🚀 DynamoDB Local をセットアップしています..."
	@docker compose up -d dynamodb-local
	@echo "⏳ DynamoDB Local の起動を待っています..."
	@bash -c 'for i in {1..15}; do \
		if curl -s -f http://localhost:8000 > /dev/null 2>&1; then \
			echo "✅ DynamoDB Local が起動しました"; \
			break; \
		fi; \
		echo "   試行 $$i/15..."; \
		sleep 2; \
	done'
	@echo "✅ DynamoDB Local のセットアップが完了しました"

# ========================================
# 🛠  その他ツール
# ========================================

docker-build: check-docker
	@echo "🐳 Control Plane の Docker イメージをビルドしています..."
	@cd $(CONTROL_PLANE_DIR) && docker build -t tenkacloud/control-plane:latest .
	@echo "✅ Docker イメージのビルドが完了しました"
	@echo ""
	@echo "📋 ビルドされたイメージ:"
	@docker images tenkacloud/control-plane:latest
	@echo ""

docker-run: docker-build
	@echo "🚀 Docker Compose で全サービスを起動しています..."
	@docker compose up -d
	@echo "✅ サービスが起動しました"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Control Plane:      http://localhost:13000"
	@echo "  - Application Plane:  http://localhost:13001"
	@echo ""

docker-stop:
	@echo "🛑 Docker Compose を停止しています..."
	@docker compose down
	@echo "✅ 停止しました"
	@echo ""

docker-status: check-docker
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🐳 Docker コンテナの起動状態"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📦 TenkaCloud サービス (Root Compose):"
	@docker compose ps || echo "  ❌ サービスが見つかりません"
	@echo ""
	@echo "🌐 すべての実行中コンテナ:"
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" || echo "  ❌ 実行中のコンテナがありません"
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""

# ========================================
# ❓ ヘルプ
# ========================================

help:
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📖 TenkaCloud Makefile ヘルプ"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "🚀 起動・停止（統合コマンド）:"
	@echo "  make start            LocalStack + フロントエンド開発サーバーをすべて起動"
	@echo "  make start-infrastructure  LocalStack のみ起動（バックエンドのみ）"
	@echo "  make stop             LocalStack を停止"
	@echo "  make restart          サービスを再起動"
	@echo "  make status           サービス状態を表示"
	@echo ""
	@echo "🧪 LocalStack テスト:"
	@echo "  make test-tenant      テスト用テナントを作成（プロビジョニングフロー起動）"
	@echo "  make logs-local       プロビジョニング Lambda のログを表示"
	@echo ""
	@echo "🐳 Docker Compose（フロントエンド）:"
	@echo "  make start-compose    Docker Compose で UI サービスを起動"
	@echo "  make stop-compose     Docker Compose サービスを停止"
	@echo "  make docker-status    Docker コンテナの起動状態を表示"
	@echo ""
	@echo "📦 パッケージ管理:"
	@echo "  make install          ルート + 全フロントエンドアプリの依存を bun でインストール"
	@echo "  make clean            ルートスクリプトの clean を実行"
	@echo ""
	@echo "🔍 コード品質:"
	@echo "  make lint             全フロントエンドアプリの lint を実行"
	@echo "  make lint_text        Textlint を実行"
	@echo "  make typecheck        全フロントエンドアプリの型チェックを実行"
	@echo "  make format           コードを自動整形"
	@echo "  make format_check     整形チェック"
	@echo "  make before_commit    lint_text + format_check + typecheck + test + build を実行"
	@echo ""
	@echo "🧪 テスト:"
	@echo "  make test             全アプリのカバレッジテストを実行（デフォルト）"
	@echo "  make test_quick       全アプリのテストを実行（カバレッジなし・高速）"
	@echo "  make test_coverage    全アプリのカバレッジテストを実行（test と同じ）"
	@echo "  make test_e2e         E2E テストを実行（Playwright）"
	@echo "  make test_e2e_ui      E2E テストを UI モードで実行"
	@echo "  make test_e2e_headed  E2E テストを headed モードで実行"
	@echo ""
	@echo "🏗  ビルド:"
	@echo "  make dev              開発サーバーを起動 (Control Plane のみ)"
	@echo "  make build            全フロントエンドアプリをビルド"
	@echo ""
	@echo "🐳 Docker ビルド:"
	@echo "  make docker-build     Control Plane UI の Docker イメージをビルド"
	@echo "  make docker-run       Docker Compose で Control Plane UI を起動"
	@echo "  make docker-stop      Docker Compose を停止"
	@echo "  make check-docker     Docker の起動状態を確認"
	@echo ""
	@echo "❓ ヘルプ:"
	@echo "  make help             このヘルプを表示"
	@echo ""
	@echo "🧪 ローカル開発（LocalStack）:"
	@echo "  make start-local      LocalStack + Terraform でローカル環境を起動"
	@echo "  make stop-local       LocalStack を停止"
	@echo "  make logs-local       プロビジョニング Lambda のログを表示"
	@echo "  make test-lambda      テナント作成をシミュレート"
	@echo ""
	@echo "🔐 Auth0 セットアップ:"
	@echo "  make auth0-setup      Auth0 を Terraform でセットアップ（init + apply + output）"
	@echo "  make auth0-init       Terraform 初期化"
	@echo "  make auth0-plan       変更内容をプレビュー"
	@echo "  make auth0-apply      Auth0 設定を適用"
	@echo "  make auth0-output     認証情報を表示（.env.local 用）"
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📚 詳細: docs/QUICKSTART.md"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ========================================
# 🧪 ローカル開発（LocalStack）
# ========================================

LOCALSTACK_ENDPOINT := http://localhost:4566
LOCAL_TABLE := TenkaCloud-local
LOCAL_LAMBDA := tenkacloud-local-provisioning

# LocalStack 用ダミー認証情報
export AWS_ACCESS_KEY_ID := test
export AWS_SECRET_ACCESS_KEY := test
export AWS_DEFAULT_REGION := ap-northeast-1

check-aws-cli:
	@command -v aws >/dev/null 2>&1 || { echo "❌ AWS CLI がインストールされていません。"; echo "   brew install awscli でインストールしてください。"; exit 1; }
	@echo "✅ AWS CLI がインストールされています"

check-terraform:
	@command -v terraform >/dev/null 2>&1 || { echo "❌ Terraform がインストールされていません。"; echo "   brew install terraform でインストールしてください。"; exit 1; }
	@echo "✅ Terraform がインストールされています"

start-local: check-docker check-aws-cli check-terraform
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🚀 LocalStack でローカル環境を起動します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@./scripts/local-setup.sh

stop-local:
	@echo "🛑 LocalStack を停止しています..."
	@docker compose stop localstack
	@echo "✅ LocalStack を停止しました"

logs-local: check-aws-cli
	@echo "📋 プロビジョニング Lambda のログを表示しています..."
	@aws --endpoint-url=$(LOCALSTACK_ENDPOINT) logs tail /aws/lambda/$(LOCAL_LAMBDA) --follow

# UUID generation with fallback for systems without uuidgen
generate-uuid = $(shell uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || od -x /dev/urandom | head -1 | awk '{print $$2$$3"-"$$4"-"$$5"-"$$6"-"$$7$$8$$9}' | head -c 36)

# test-tenant / test-lambda: テスト用テナントを作成してプロビジョニングフローを起動
test-tenant: test-lambda
test-lambda: check-aws-cli
	@echo "🧪 テナント作成をシミュレートしています..."
	@TENANT_ID=$$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || od -x /dev/urandom | head -1 | awk '{print $$2$$3"-"$$4"-"$$5"-"$$6"-"$$7$$8$$9}' | head -c 36 | tr '[:upper:]' '[:lower:]' | head -c 8); \
	TIMESTAMP=$$(date -u +%Y-%m-%dT%H:%M:%SZ); \
	aws --endpoint-url=$(LOCALSTACK_ENDPOINT) dynamodb put-item \
		--table-name $(LOCAL_TABLE) \
		--item "{\"PK\":{\"S\":\"TENANT#$$TENANT_ID\"},\"SK\":{\"S\":\"METADATA\"},\"id\":{\"S\":\"$$TENANT_ID\"},\"name\":{\"S\":\"Test Tenant $$TENANT_ID\"},\"slug\":{\"S\":\"test-$$TENANT_ID\"},\"tier\":{\"S\":\"FREE\"},\"status\":{\"S\":\"ACTIVE\"},\"provisioningStatus\":{\"S\":\"PENDING\"},\"EntityType\":{\"S\":\"TENANT\"},\"CreatedAt\":{\"S\":\"$$TIMESTAMP\"},\"UpdatedAt\":{\"S\":\"$$TIMESTAMP\"}}"
	@echo "✅ テナントを作成しました"
	@echo ""
	@echo "💡 ログを確認: make logs-local"

# ========================================
# 🔐 Auth0 セットアップ（Terraform）
# ========================================

AUTH0_TF_DIR := infrastructure/terraform/environments/dev

auth0-check-tfvars:
	@if [ ! -f $(AUTH0_TF_DIR)/terraform.tfvars ]; then \
		echo "❌ terraform.tfvars が見つかりません"; \
		echo ""; \
		echo "📋 セットアップ手順:"; \
		echo "  1. cp $(AUTH0_TF_DIR)/terraform.tfvars.example $(AUTH0_TF_DIR)/terraform.tfvars"; \
		echo "  2. Auth0 Dashboard (https://manage.auth0.com) にログイン"; \
		echo "  3. Applications > APIs > Auth0 Management API を選択"; \
		echo "  4. Machine to Machine Applications タブで新しいアプリを作成"; \
		echo "  5. 必要な権限を付与（詳細は terraform.tfvars.example を参照）"; \
		echo "  6. terraform.tfvars に認証情報を設定"; \
		echo ""; \
		exit 1; \
	fi
	@echo "✅ terraform.tfvars が存在します"

auth0-init: check-terraform auth0-check-tfvars
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🔐 Auth0 Terraform を初期化します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@cd $(AUTH0_TF_DIR) && terraform init

auth0-plan: check-terraform auth0-check-tfvars
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🔐 Auth0 Terraform の変更を確認します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@cd $(AUTH0_TF_DIR) && terraform plan

auth0-apply: check-terraform auth0-check-tfvars
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🔐 Auth0 設定を適用します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@cd $(AUTH0_TF_DIR) && terraform apply

auth0-output:
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🔐 Auth0 認証情報を表示します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 Control Plane (.env.local に追加):"
	@cd $(AUTH0_TF_DIR) && terraform output -json 2>/dev/null | jq -r '"AUTH0_CLIENT_ID=\(.auth0_control_plane_client_id.value)\nAUTH0_CLIENT_SECRET=\(.auth0_control_plane_client_secret.value)\nAUTH0_ISSUER=https://\(.auth0_api_identifier.value | split("/")[2])"' 2>/dev/null || echo "  ❌ Terraform output が取得できません。make auth0-apply を先に実行してください。"
	@echo ""
	@echo "📋 Application Plane (.env.local に追加):"
	@cd $(AUTH0_TF_DIR) && terraform output -json 2>/dev/null | jq -r '"AUTH0_CLIENT_ID=\(.auth0_application_plane_client_id.value)\nAUTH0_CLIENT_SECRET=\(.auth0_application_plane_client_secret.value)"' 2>/dev/null || echo "  ❌ Terraform output が取得できません。make auth0-apply を先に実行してください。"
	@echo ""

auth0-setup: auth0-init auth0-apply auth0-output
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✅ Auth0 セットアップが完了しました"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "💡 上記の環境変数を各アプリの .env.local にコピーしてください"
	@echo ""
