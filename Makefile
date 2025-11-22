.PHONY: help install install_ci setup_husky clean lint lint_text format format_check before_commit before-commit start test test_coverage dev build start-all stop-all restart-all setup-keycloak check-docker docker-build docker-run docker-stop docker-status

# デフォルトターゲットはhelp
default: help

NODE_RUNNER ?= npm
BUN ?= bun
FRONTEND_DIR ?= frontend/control-plane
CONTROL_PLANE_DIR := frontend/control-plane
ADMIN_APP_DIR := frontend/admin-app
PARTICIPANT_APP_DIR := frontend/participant-app
LANDING_SITE_DIR := frontend/landing-site
FRONTEND_APPS := $(CONTROL_PLANE_DIR) $(ADMIN_APP_DIR) $(PARTICIPANT_APP_DIR) $(LANDING_SITE_DIR)

lint_text:
	$(NODE_RUNNER) run lint_text

format_check:
	$(NODE_RUNNER) run format_check

install:
	$(BUN) install
	@for app in $(FRONTEND_APPS); do \
		echo "📦 $$app の依存関係をインストール中..."; \
		cd $$app && $(BUN) install && cd ../..; \
	done
	@echo "✅ すべてのフロントエンドアプリの依存関係をインストールしました"

install_ci:
	$(BUN) run install:ci
	cd $(FRONTEND_DIR) && $(BUN) install --frozen-lockfile

setup_husky:
	$(BUN) run husky

clean:
	$(NODE_RUNNER) run clean || true

lint:
	@echo "🔍 全フロントエンドアプリの lint を実行中..."
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📋 $$app の lint..."; \
		$(NODE_RUNNER) --prefix $$app run lint || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリの lint が成功しました"

format:
	$(NODE_RUNNER) run format

typecheck:
	@echo "🔍 全フロントエンドアプリの型チェックを実行中..."
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📋 $$app の型チェック..."; \
		$(NODE_RUNNER) --prefix $$app run typecheck || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリの型チェックが成功しました"

build:
ifeq ($(SKIP_FRONTEND_BUILD),1)
	@echo "⚠️  SKIP_FRONTEND_BUILD=1 が設定されているため build をスキップします"
else
	@echo "🏗  全フロントエンドアプリをビルド中..."
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📦 $$app をビルド中..."; \
		NEXT_TELEMETRY_DISABLED=1 $(NODE_RUNNER) --prefix $$app run build -- --webpack || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリのビルドが成功しました"
endif

dev:
	$(NODE_RUNNER) --prefix $(FRONTEND_DIR) run dev

start:
	$(NODE_RUNNER) --prefix $(FRONTEND_DIR) run start

test:
	@echo "🧪 全フロントエンドアプリのテストを実行中..."
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "🔬 $$app のテスト..."; \
		$(NODE_RUNNER) --prefix $$app run test || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリのテストが成功しました"

test_coverage:
	@echo "📊 全フロントエンドアプリのカバレッジテストを実行中..."
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📈 $$app のカバレッジテスト..."; \
		$(NODE_RUNNER) --prefix $$app run test:coverage || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリのカバレッジテストが成功しました"

before_commit: lint_text format_check typecheck test build
	@echo "✅ すべてのコミット前チェックが完了しました"

# ハイフン付きのエイリアス（打ち間違え対策）
# ハイフン付きのエイリアス（打ち間違え対策）
before-commit: before_commit

check-docker:
	@echo "🔍 Docker の起動状態を確認しています..."
	@docker --version > /dev/null 2>&1 || (echo "❌ Docker がインストールされていません" && exit 1)
	@docker ps > /dev/null 2>&1 || (echo "❌ Docker が起動していません。Docker Desktop を起動してください。" && exit 1)
	@echo "✅ Docker は起動しています"

setup-keycloak: check-docker
	@echo "🚀 Keycloak をセットアップしています..."
	@cd infrastructure/docker/keycloak && docker compose up -d
	@echo "⏳ Keycloak の起動を待っています（最大60秒）..."
	@bash -c 'for i in {1..30}; do \
		if curl -s -f http://localhost:8080/health/ready > /dev/null 2>&1; then \
			echo "✅ Keycloak が起動しました"; \
			break; \
		fi; \
		echo "   試行 $$i/30..."; \
		sleep 2; \
	done'
	@echo "🔧 Keycloak の自動設定を実行しています..."
	@cd infrastructure/docker/keycloak && ./scripts/setup-keycloak.sh

start-infrastructure: check-docker
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🚀 TenkaCloud インフラストラクチャを起動します"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📦 ステップ 1/3: Keycloak を起動しています..."
	@cd infrastructure/docker/keycloak && docker compose up -d
	@echo "⏳ Keycloak の起動を待っています（最大60秒）..."
	@bash -c 'for i in {1..30}; do \
		if curl -s -f http://localhost:8080/health/ready > /dev/null 2>&1; then \
			echo "✅ Keycloak が起動しました"; \
			break; \
		fi; \
		echo "   試行 $$i/30..."; \
		sleep 2; \
	done'
	@echo ""
	@echo "🔧 ステップ 2/3: Keycloak の自動設定を実行しています..."
	@cd infrastructure/docker/keycloak && ./scripts/setup-keycloak.sh || true
	@echo ""
	@echo "📝 ステップ 3/3: 環境変数ファイルを確認しています..."
	@if [ ! -f frontend/control-plane/.env.local ]; then \
		echo "⚠️  .env.local が見つかりません。.env.example からコピーしています..."; \
		cd frontend/control-plane && cp .env.example .env.local; \
		echo ""; \
		echo "⚠️  重要: frontend/control-plane/.env.local を編集して以下を設定してください:"; \
		echo "  - AUTH_SECRET (openssl rand -base64 32 で生成)"; \
		echo "  - AUTH_KEYCLOAK_SECRET (上記の Keycloak セットアップで表示された値)"; \
	else \
		echo "✅ .env.local が存在します"; \
	fi
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✨ インフラストラクチャの起動が完了しました！"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Keycloak:         http://localhost:8080"
	@echo ""

start-control-plane:
	@echo "🚀 Control Plane UI を起動します..."
	$(NODE_RUNNER) --prefix $(FRONTEND_DIR) run dev

start: start-all

start-all: check-docker
	@echo "🚀 TenkaCloud 全サービスを Docker で起動します..."
	@docker compose up -d --build
	@echo "⏳ Keycloak の起動を待っています（最大60秒）..."
	@bash -c 'for i in {1..30}; do \
		if curl -s -f http://localhost:8080 > /dev/null 2>&1; then \
			echo "✅ Keycloak が起動しました"; \
			break; \
		fi; \
		echo "   試行 $$i/30..."; \
		sleep 2; \
	done'
	@echo "🔧 Keycloak の自動設定を実行しています..."
	@cd infrastructure/docker/keycloak && KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=admin ./scripts/setup-keycloak.sh || true
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✨ 全サービスの起動が完了しました！"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Landing Site:     http://localhost:3003"
	@echo "  - Control Plane UI: http://localhost:3000"
	@echo "  - Admin App:        http://localhost:3001"
	@echo "  - Participant App:  http://localhost:3002"
	@echo "  - Keycloak:         http://localhost:8080"
	@echo ""

stop-infrastructure:
	@echo "🛑 TenkaCloud インフラストラクチャを停止しています..."
	@cd infrastructure/docker/keycloak && docker compose down
	@echo "✅ インフラストラクチャを停止しました"

stop-control-plane:
	@echo "🛑 Control Plane UI を停止しています..."
	@docker compose stop control-plane-ui || true
	@echo "✅ Control Plane UI を停止しました"

stop: stop-all

stop-all:
	@echo "🛑 全サービスを停止しています..."
	@docker compose down
	@echo "✅ 全サービスを停止しました"

restart-all: stop-all start-all

docker-build: check-docker
	@echo "🐳 Control Plane UI の Docker イメージをビルドしています..."
	@cd frontend/control-plane && docker build -t tenkacloud/control-plane-ui:latest .
	@echo "✅ Docker イメージのビルドが完了しました"
	@echo ""
	@echo "📋 ビルドされたイメージ:"
	@docker images tenkacloud/control-plane-ui:latest
	@echo ""

docker-run: docker-build
	@echo "🚀 Docker Compose で Control Plane UI を起動しています..."
	@cd frontend/control-plane && docker compose up -d
	@echo "✅ Control Plane UI が起動しました"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Control Plane UI: http://localhost:3000"
	@echo "  - Keycloak:         http://localhost:8080"
	@echo ""

docker-stop:
	@echo "🛑 Docker Compose を停止しています..."
	@cd frontend/control-plane && docker compose down
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

help:
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📖 TenkaCloud Makefile ヘルプ"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "🚀 ローカル環境管理:"
	@echo "  make start            全サービス（インフラ + UI）を起動"
	@echo "  make start-all        make start と同じ"
	@echo "  make start-control-plane Control Plane UI のみを起動"
	@echo "  make start-infrastructure インフラ（Keycloak）のみを起動"
	@echo "  make stop-all         ローカル環境を一括停止"
	@echo "  make restart-all      ローカル環境を再起動"
	@echo "  make setup-keycloak   Keycloak のみセットアップ"
	@echo "  make check-docker     Docker の起動状態を確認"
	@echo ""
	@echo "🐳 Docker ビルド:"
	@echo "  make docker-build     Control Plane UI の Docker イメージをビルド"
	@echo "  make docker-run       Docker Compose で Control Plane UI を起動"
	@echo "  make docker-stop      Docker Compose を停止"
	@echo "  make docker-status    Docker コンテナの起動状態を表示"
	@echo ""
	@echo "📦 パッケージ管理:"
	@echo "  make install          ルート + 全フロントエンドアプリの依存を bun でインストール"
	@echo "  make clean            ルートスクリプトの clean を実行 (存在しない場合は no-op)"
	@echo ""
	@echo "🔍 コード品質:"
	@echo "  make lint             全フロントエンドアプリの lint を実行"
	@echo "  make lint_text        Textlint を実行"
	@echo "  make typecheck        全フロントエンドアプリの型チェックを実行"
	@echo "  make format           コードを自動整形"
	@echo "  make format_check     整形チェック"
	@echo "  make before_commit    lint_text + format_check + typecheck + test + build を実行"
	@echo "                       （全フロントエンドアプリに対して）"
	@echo "                       ※SKIP_FRONTEND_BUILD=1 で build をスキップ可能"
	@echo ""
	@echo "🧪 テスト:"
	@echo "  make test             全フロントエンドアプリのテストを実行"
	@echo "  make test_coverage    全フロントエンドアプリのカバレッジテストを実行"
	@echo ""
	@echo "🏗  ビルド:"
	@echo "  make dev              開発サーバーを起動 (Control Plane のみ)"
	@echo "  make build            全フロントエンドアプリをビルド"
	@echo "  make start            本番サーバーを起動 (Control Plane のみ)"
	@echo ""
	@echo "☸️  Kubernetes:"
	@echo "  make k8s-build-all    全サービスの Docker イメージをビルド"
	@echo "  make k8s-deploy       Kubernetes にデプロイ"
	@echo "  make k8s-delete       Kubernetes リソースを削除"
	@echo ""
	@echo "❓ ヘルプ:"
	@echo "  make help             このヘルプを表示"
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📚 詳細: docs/QUICKSTART.md"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

k8s-build-all: check-docker
	@echo "🐳 全サービスの Docker イメージをビルドしています..."
	@echo "📦 Control Plane UI..."
	@cd frontend/control-plane && docker build -t tenkacloud/control-plane-ui:latest .
	@echo "📦 Admin App..."
	@docker build -t tenkacloud/admin-app:latest -f frontend/admin-app/Dockerfile .
	@echo "📦 Participant App..."
	@docker build -t tenkacloud/participant-app:latest -f frontend/participant-app/Dockerfile .
	@echo "📦 Landing Site..."
	@docker build -t tenkacloud/landing-site:latest -f frontend/landing-site/Dockerfile .
	@echo "✅ 全イメージのビルドが完了しました"

k8s-deploy: check-docker
	@echo "🚀 Kubernetes にデプロイしています..."
	@kubectl apply -f infrastructure/k8s/base/namespace.yaml
	@kubectl apply -f infrastructure/k8s/base/keycloak.yaml
	@kubectl apply -f infrastructure/k8s/control-plane/control-plane-ui.yaml
	@kubectl apply -f infrastructure/k8s/application-plane/admin-app.yaml
	@kubectl apply -f infrastructure/k8s/application-plane/participant-app.yaml
	@kubectl apply -f infrastructure/k8s/application-plane/landing-site.yaml
	@echo "✅ デプロイが完了しました"
	@echo ""
	@echo "📋 次のステップ:"
	@echo "  1. Keycloak のセットアップ:"
	@echo "     kubectl port-forward svc/keycloak 8080:8080 -n tenkacloud"
	@echo "     (別のターミナルで) ./infrastructure/docker/keycloak/scripts/setup-keycloak.sh"
	@echo "  2. /etc/hosts の設定:"
	@echo "     127.0.0.1 keycloak"
	@echo "  3. アプリケーションへのアクセス (port-forward):"
	@echo "     kubectl port-forward svc/control-plane-ui 3000:3000 -n tenkacloud"
	@echo "     kubectl port-forward svc/admin-app 3001:3001 -n tenkacloud"
	@echo "     kubectl port-forward svc/participant-app 3002:3002 -n tenkacloud"
	@echo "     kubectl port-forward svc/landing-site 3003:3003 -n tenkacloud"

k8s-delete:
	@echo "🗑️  Kubernetes リソースを削除しています..."
	@kubectl delete -f infrastructure/k8s/application-plane/landing-site.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/application-plane/participant-app.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/application-plane/admin-app.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/control-plane/control-plane-ui.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/base/keycloak.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/base/namespace.yaml --ignore-not-found
	@echo "✅ 削除が完了しました"
