.PHONY: help install install_ci setup_husky clean lint lint_text format format_check before_commit before-commit start test test_quick test_coverage dev build
.PHONY: start-compose start-k8s start stop-compose stop-k8s stop restart status
.PHONY: start-infrastructure start-control-plane stop-infrastructure stop-control-plane restart-all
.PHONY: check-docker check-k8s k8s-build-all k8s-deploy k8s-delete docker-build docker-run docker-stop docker-status
.PHONY: k8s-forward k8s-forward-stop k8s-start-full

# デフォルトターゲットはhelp
default: help

# ni: パッケージマネージャー自動選択ツール（bun.lockb を検出して bun を使用）
# NI  = bunx ni   (依存関係インストール = bun install 相当)
# NR  = bunx nr   (スクリプト実行 = bun run 相当)
# NLX = bunx nlx  (パッケージ一時実行 = bunx 相当)
NI ?= bunx ni
NR ?= bunx nr
NLX ?= bunx nlx
BUN ?= bun
FRONTEND_DIR ?= frontend/control-plane
CONTROL_PLANE_DIR := frontend/control-plane
ADMIN_APP_DIR := frontend/admin-app
PARTICIPANT_APP_DIR := frontend/participant-app
LANDING_SITE_DIR := frontend/landing-site
FRONTEND_APPS := $(CONTROL_PLANE_DIR) $(ADMIN_APP_DIR) $(PARTICIPANT_APP_DIR) $(LANDING_SITE_DIR)
BACKEND_SERVICES_DIR := backend/services
PROBLEM_MANAGEMENT_DIR := $(BACKEND_SERVICES_DIR)/problem-management

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
	(cd $(FRONTEND_DIR) && $(BUN) install --frozen-lockfile --ignore-scripts)

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
		(cd $$app && NEXT_TELEMETRY_DISABLED=1 $(NR) build) || exit 1; \
	done
	@echo ""
	@echo "✅ すべてのフロントエンドアプリのビルドが成功しました"
endif

dev:
	cd $(FRONTEND_DIR) && $(NR) dev

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
	@echo "📦 バックエンドサービス:"
	@echo ""
	@echo "🔬 $(PROBLEM_MANAGEMENT_DIR) のテスト..."
	@(cd $(PROBLEM_MANAGEMENT_DIR) && $(NR) test) || exit 1
	@echo ""
	@echo "✅ すべてのテストが成功しました"

test_coverage:
	@echo "📊 全アプリのカバレッジテストを実行中..."
	@echo ""
	@echo "📦 フロントエンドアプリ:"
	@for app in $(FRONTEND_APPS); do \
		echo ""; \
		echo "📈 $$app のカバレッジテスト..."; \
		(cd $$app && $(NR) test:coverage) || exit 1; \
	done
	@echo ""
	@echo "📦 バックエンドサービス:"
	@echo ""
	@echo "📈 $(PROBLEM_MANAGEMENT_DIR) のカバレッジテスト..."
	@(cd $(PROBLEM_MANAGEMENT_DIR) && $(NR) test:coverage) || exit 1
	@echo ""
	@echo "✅ すべてのカバレッジテストが成功しました"

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

check-k8s:
	@echo "🔍 Kubernetes クラスターを確認しています..."
	@kubectl cluster-info > /dev/null 2>&1 || \
		(echo "❌ Kubernetes クラスターに接続できません" && \
		 echo "" && \
		 echo "📋 対処方法:" && \
		 echo "  1. Docker Desktop を起動: open -a Docker" && \
		 echo "  2. Kubernetes > Create Kubernetes Cluster" && \
		 echo "  3. Kubeadm を選択して Create をクリック" && \
		 echo "  4. 数分待ってから再度実行" && \
		 echo "" && \
		 echo "詳細: docs/KUBERNETES.md" && \
		 exit 1)
	@echo "✅ Kubernetes クラスターに接続できました"

# ========================================
# 🚀 起動・停止（統合コマンド）
# ========================================

start:
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🚀 TenkaCloud デプロイ方法を選択してください"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "  1) Docker Compose（ローカル開発・推奨）"
	@echo "  2) Kubernetes（本番相当環境）"
	@echo ""
	@printf "選択 [1-2]: " && read choice; \
	case $$choice in \
		1) $(MAKE) start-compose ;; \
		2) $(MAKE) k8s-start-full ;; \
		*) echo "❌ 無効な選択です" && exit 1 ;; \
	esac

stop:
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🛑 TenkaCloud サービス停止"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "  1) Docker Compose サービスを停止"
	@echo "  2) Kubernetes サービスを停止"
	@echo "  3) すべて停止"
	@echo ""
	@printf "選択 [1-3]: " && read choice; \
	case $$choice in \
		1) $(MAKE) stop-compose ;; \
		2) $(MAKE) stop-k8s ;; \
		3) $(MAKE) stop-compose && $(MAKE) stop-k8s ;; \
		*) echo "❌ 無効な選択です" && exit 1 ;; \
	esac

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
	@echo "☸️  Kubernetes:"
	@kubectl get pods -n tenkacloud 2>/dev/null || echo "  ❌ デプロイされていません"
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

stop-compose:
	@echo "🛑 Docker Compose サービスを停止しています..."
	@docker compose down
	@echo "✅ 停止しました"

# 後方互換性
start-all: start-compose
stop-all: stop-compose
restart-all: stop-compose start-compose

# ========================================
# ☸️  Kubernetes（本番相当環境）
# ========================================

k8s-build-all: check-docker
	@echo "🐳 全サービスの Docker イメージをビルドしています..."
	@echo "📦 Control Plane UI..."
	@cd frontend/control-plane && docker build -t tenkacloud/control-plane-ui:latest .
	@echo "📦 Tenant Management Service..."
	@cd backend/services/control-plane/tenant-management && docker build -t tenkacloud/tenant-management:latest .
	@echo "📦 Admin App..."
	@docker build -t tenkacloud/admin-app:latest -f frontend/admin-app/Dockerfile .
	@echo "📦 Participant App..."
	@docker build -t tenkacloud/participant-app:latest -f frontend/participant-app/Dockerfile .
	@echo "📦 Landing Site..."
	@docker build -t tenkacloud/landing-site:latest -f frontend/landing-site/Dockerfile .
	@echo "✅ 全イメージのビルドが完了しました"

start-k8s: check-k8s k8s-build-all
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "☸️  Kubernetes に TenkaCloud をデプロイします"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@$(MAKE) k8s-deploy
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✨ Kubernetes デプロイが完了しました！"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 次のステップ:"
	@echo "  make k8s-forward      # port-forward を一発起動"
	@echo ""
	@echo "💡 または一発で全部やりたい場合:"
	@echo "  make k8s-start-full   # ビルド+デプロイ+port-forward+Keycloak設定"
	@echo ""

k8s-deploy: check-k8s
	@echo "🚀 Kubernetes にデプロイしています..."
	@kubectl apply -f infrastructure/k8s/base/namespace.yaml
	@kubectl apply -f infrastructure/k8s/base/secrets.yaml
	@kubectl apply -f infrastructure/k8s/base/postgres.yaml
	@kubectl apply -f infrastructure/k8s/base/keycloak.yaml
	@kubectl apply -f infrastructure/k8s/control-plane/tenant-management.yaml
	@kubectl apply -f infrastructure/k8s/control-plane/control-plane-ui.yaml
	@kubectl apply -f infrastructure/k8s/application-plane/admin-app.yaml
	@kubectl apply -f infrastructure/k8s/application-plane/participant-app.yaml
	@kubectl apply -f infrastructure/k8s/application-plane/landing-site.yaml
	@echo "✅ デプロイが完了しました"

k8s-delete:
	@echo "🗑️  Kubernetes リソースを削除しています..."
	@kubectl delete -f infrastructure/k8s/application-plane/landing-site.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/application-plane/participant-app.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/application-plane/admin-app.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/control-plane/control-plane-ui.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/control-plane/tenant-management.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/base/keycloak.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/base/postgres.yaml --ignore-not-found
	@kubectl delete -f infrastructure/k8s/base/namespace.yaml --ignore-not-found
	@echo "✅ 削除が完了しました"

K8S_PID_FILE := /tmp/tenkacloud-k8s-pids

k8s-forward: check-k8s
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "🔗 Kubernetes port-forward を起動しています..."
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@# 既存のプロセスを停止
	@$(MAKE) k8s-forward-stop 2>/dev/null || true
	@# Pod の準備を待機
	@echo "⏳ Pod の準備を待っています..."
	@kubectl wait --for=condition=ready pod -l app=keycloak -n tenkacloud --timeout=120s 2>/dev/null || true
	@kubectl wait --for=condition=ready pod -l app=landing-site -n tenkacloud --timeout=60s 2>/dev/null || true
	@kubectl wait --for=condition=ready pod -l app=control-plane-ui -n tenkacloud --timeout=60s 2>/dev/null || true
	@kubectl wait --for=condition=ready pod -l app=admin-app -n tenkacloud --timeout=60s 2>/dev/null || true
	@kubectl wait --for=condition=ready pod -l app=participant-app -n tenkacloud --timeout=60s 2>/dev/null || true
	@# port-forward を起動
	@echo "🚀 Port-forward を起動中..."
	@kubectl port-forward svc/keycloak 8080:8080 -n tenkacloud > /dev/null 2>&1 & echo $$! >> $(K8S_PID_FILE)
	@kubectl port-forward svc/landing-site 3003:3003 -n tenkacloud > /dev/null 2>&1 & echo $$! >> $(K8S_PID_FILE)
	@kubectl port-forward svc/control-plane-ui 3000:3000 -n tenkacloud > /dev/null 2>&1 & echo $$! >> $(K8S_PID_FILE)
	@kubectl port-forward svc/admin-app 3001:3001 -n tenkacloud > /dev/null 2>&1 & echo $$! >> $(K8S_PID_FILE)
	@kubectl port-forward svc/participant-app 3002:3002 -n tenkacloud > /dev/null 2>&1 & echo $$! >> $(K8S_PID_FILE)
	@kubectl port-forward svc/tenant-management 3004:3004 -n tenkacloud > /dev/null 2>&1 & echo $$! >> $(K8S_PID_FILE)
	@sleep 2
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✅ Port-forward が起動しました"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Landing Site:       http://localhost:3003"
	@echo "  - Control Plane UI:   http://localhost:3000"
	@echo "  - Admin App:          http://localhost:3001"
	@echo "  - Participant App:    http://localhost:3002"
	@echo "  - Tenant Management:  http://localhost:3004"
	@echo "  - Keycloak:           http://localhost:8080"
	@echo ""
	@echo "💡 停止するには: make k8s-forward-stop"
	@echo ""

k8s-forward-stop:
	@echo "🛑 Port-forward を停止しています..."
	@if [ -f $(K8S_PID_FILE) ]; then \
		while read pid; do \
			kill $$pid 2>/dev/null || true; \
		done < $(K8S_PID_FILE); \
		rm -f $(K8S_PID_FILE); \
		echo "✅ Port-forward を停止しました"; \
	else \
		echo "⚠️  実行中の port-forward が見つかりません"; \
	fi
	@# 念のため残存プロセスも停止
	@pkill -f "kubectl port-forward.*tenkacloud" 2>/dev/null || true

k8s-start-full: check-k8s k8s-build-all
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "☸️  Kubernetes フルスタート（デプロイ + port-forward + Keycloak セットアップ）"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@# デプロイ
	@$(MAKE) k8s-deploy
	@echo ""
	@# Port-forward 起動
	@$(MAKE) k8s-forward
	@echo ""
	@# Keycloak セットアップ
	@echo "🔧 Keycloak の自動設定を実行しています..."
	@echo "⏳ Keycloak の起動を待っています（最大60秒）..."
	@bash -c 'for i in {1..30}; do \
		if curl -s -f http://localhost:8080 > /dev/null 2>&1; then \
			echo "✅ Keycloak が起動しました"; \
			break; \
		fi; \
		echo "   試行 $$i/30..."; \
		sleep 2; \
	done'
	@cd infrastructure/docker/keycloak && KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=admin ./scripts/setup-keycloak.sh || true
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "✨ Kubernetes フルスタートが完了しました！"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "📋 アクセス先:"
	@echo "  - Landing Site:       http://localhost:3003"
	@echo "  - Control Plane UI:   http://localhost:3000"
	@echo "  - Admin App:          http://localhost:3001"
	@echo "  - Participant App:    http://localhost:3002"
	@echo "  - Tenant Management:  http://localhost:3004"
	@echo "  - Keycloak:           http://localhost:8080"
	@echo ""
	@echo "💡 停止するには: make stop-k8s"
	@echo ""

stop-k8s: k8s-forward-stop k8s-delete

# ========================================
# 🏢 インフラストラクチャ管理（従来版・互換性）
# ========================================

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

stop-infrastructure:
	@echo "🛑 TenkaCloud インフラストラクチャを停止しています..."
	@cd infrastructure/docker/keycloak && docker compose down
	@echo "✅ インフラストラクチャを停止しました"

start-control-plane:
	@echo "🚀 Control Plane UI を起動します..."
	cd $(FRONTEND_DIR) && $(NR) dev

stop-control-plane:
	@echo "🛑 Control Plane UI を停止しています..."
	@docker compose stop control-plane-ui || true
	@echo "✅ Control Plane UI を停止しました"

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

# ========================================
# 🛠  その他ツール
# ========================================

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

# ========================================
# ❓ ヘルプ
# ========================================

help:
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📖 TenkaCloud Makefile ヘルプ"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "🚀 デプロイ（統合コマンド）:"
	@echo "  make start            デプロイ方法を選択（Docker Compose / Kubernetes）"
	@echo "  make stop             サービスを停止（選択式）"
	@echo "  make restart          サービスを再起動"
	@echo "  make status           サービス状態を表示"
	@echo ""
	@echo "🐳 Docker Compose（ローカル開発・推奨）:"
	@echo "  make start-compose    Docker Compose で全サービスを起動"
	@echo "  make stop-compose     Docker Compose サービスを停止"
	@echo "  make docker-status    Docker コンテナの起動状態を表示"
	@echo ""
	@echo "☸️  Kubernetes（本番相当環境）:"
	@echo "  make k8s-start-full   ★ビルド+デプロイ+port-forward+Keycloak設定を一発で実行"
	@echo "  make check-k8s        Kubernetes クラスターの接続確認"
	@echo "  make k8s-build-all    全サービスの Docker イメージをビルド"
	@echo "  make start-k8s        Kubernetes にビルド&デプロイ"
	@echo "  make k8s-deploy       Kubernetes にデプロイ（ビルド済み前提）"
	@echo "  make k8s-forward      全サービスの port-forward を起動"
	@echo "  make k8s-forward-stop port-forward を停止"
	@echo "  make stop-k8s         Kubernetes リソース+port-forward を停止"
	@echo ""
	@echo "🏢 インフラストラクチャ管理:"
	@echo "  make start-infrastructure  インフラ（Keycloak）のみを起動"
	@echo "  make start-control-plane   Control Plane UI のみを起動"
	@echo "  make stop-infrastructure   インフラを停止"
	@echo "  make setup-keycloak        Keycloak のみセットアップ"
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
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "📚 詳細: docs/QUICKSTART.md, docs/KUBERNETES.md"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
