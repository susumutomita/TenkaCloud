.PHONY: help install install_ci setup_husky clean lint lint_text format format_check before_commit before-commit start test test_coverage dev build start-all stop-all restart-all setup-keycloak check-docker docker-build docker-run docker-stop docker-status

# デフォルトターゲットはhelp
default: help

NODE_RUNNER ?= npm
BUN ?= bun
FRONTEND_DIR ?= frontend/control-plane

lint_text:
	$(NODE_RUNNER) run lint_text

format_check:
	$(NODE_RUNNER) run format_check

install:
	$(BUN) install
	cd $(FRONTEND_DIR) && $(BUN) install

install_ci:
	$(BUN) run install:ci
	cd $(FRONTEND_DIR) && $(BUN) install --frozen-lockfile

setup_husky:
	$(BUN) run husky

clean:
	$(NODE_RUNNER) run clean || true

lint:
	$(NODE_RUNNER) run lint || true

format:
	$(NODE_RUNNER) run format

typecheck:
	$(NODE_RUNNER) --prefix $(FRONTEND_DIR) run typecheck

build:
ifeq ($(SKIP_FRONTEND_BUILD),1)
	@echo "⚠️  SKIP_FRONTEND_BUILD=1 が設定されているため build をスキップします"
else
	NEXT_TELEMETRY_DISABLED=1 $(NODE_RUNNER) --prefix $(FRONTEND_DIR) run build
endif

dev:
	$(NODE_RUNNER) --prefix $(FRONTEND_DIR) run dev

start:
	$(NODE_RUNNER) --prefix $(FRONTEND_DIR) run start

test:
	$(NODE_RUNNER) run test

test_coverage:
	$(NODE_RUNNER) run test:coverage

before_commit: lint_text format_check typecheck build
	@echo "✅ すべてのコミット前チェックが完了しました"

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

start-all: check-docker
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🚀 TenkaCloud ローカル環境を起動します"
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
		echo ""; \
		echo "設定後、以下のコマンドで Control Plane UI を起動してください:"; \
		echo "  cd frontend/control-plane && bun run dev"; \
	else \
		echo "✅ .env.local が存在します"; \
		echo ""; \
		echo "🎯 Control Plane UI を起動するには:"; \
		echo "  cd frontend/control-plane && bun run dev"; \
	fi
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✨ ローカル環境の起動が完了しました！"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Keycloak:         http://localhost:8080"
	@echo "  - Control Plane UI: http://localhost:3000 (bun run dev 実行後)"
	@echo ""
	@echo "📚 詳細は docs/QUICKSTART.md を参照してください"
	@echo ""

stop-all:
	@echo "🛑 TenkaCloud ローカル環境を停止しています..."
	@echo ""
	@echo "📦 Keycloak を停止しています..."
	@cd infrastructure/docker/keycloak && docker compose down
	@echo ""
	@echo "✅ ローカル環境を停止しました"
	@echo ""
	@echo "💡 データを保持したまま停止する場合:"
	@echo "   cd infrastructure/docker/keycloak && docker compose stop"
	@echo ""

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
	@echo "📦 Keycloak コンテナ:"
	@cd infrastructure/docker/keycloak && docker compose ps || echo "  ❌ Keycloak コンテナが見つかりません"
	@echo ""
	@echo "📦 Control Plane UI コンテナ:"
	@cd frontend/control-plane && docker compose ps || echo "  ❌ Control Plane UI コンテナが見つかりません"
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
	@echo "  make start-all        ローカル環境を一括起動（Keycloak + 自動設定）"
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
	@echo "  make install          ルート + frontend/control-plane の依存を bun でインストール"
	@echo "  make clean            ルートスクリプトの clean を実行 (存在しない場合は no-op)"
	@echo ""
	@echo "🔍 コード品質:"
	@echo "  make lint             ルートの lint スクリプトを実行"
	@echo "  make lint_text        Textlint を実行"
	@echo "  make typecheck        frontend/control-plane の型チェック (npm --prefix ... run typecheck)"
	@echo "  make format           コードを自動整形"
	@echo "  make format_check     整形チェック"
	@echo "  make before_commit    lint_text + format_check + typecheck + build を実行"
	@echo "                       ※SKIP_FRONTEND_BUILD=1 で build をスキップ可能"
	@echo ""
	@echo "🧪 テスト:"
	@echo "  make test             テストを実行"
	@echo "  make test_coverage    カバレッジレポート付きテスト"
	@echo ""
	@echo "🏗  ビルド:"
	@echo "  make dev              開発サーバーを起動"
	@echo "  make build            プロジェクトをビルド"
	@echo "  make start            本番サーバーを起動"
	@echo ""
	@echo "❓ ヘルプ:"
	@echo "  make help             このヘルプを表示"
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📚 詳細: docs/QUICKSTART.md"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
