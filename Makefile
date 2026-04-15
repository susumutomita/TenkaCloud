.PHONY: install install_ci start stop restart status start-aws test test_quick test_e2e before-commit build seed help

default: help

# Bun binary resolution (prefer direct bin over proto shims)
PROTO_BIN := $(HOME)/.proto/bin
MISE_BUN_BIN := $(HOME)/.local/share/mise/installs/bun/1.2.20/bin
ifeq ($(wildcard $(PROTO_BIN)/bun),$(PROTO_BIN)/bun)
	BUN ?= $(PROTO_BIN)/bun
else ifeq ($(wildcard $(MISE_BUN_BIN)/bun),$(MISE_BUN_BIN)/bun)
	BUN ?= $(MISE_BUN_BIN)/bun
else
	BUN ?= bun
endif
export PATH := $(PROTO_BIN):$(MISE_BUN_BIN):$(PATH)

NR := $(BUN)x nr
CONTROL_PLANE_DIR := apps/control-plane
APPLICATION_PLANE_DIR := apps/application-plane
FRONTEND_APPS := $(CONTROL_PLANE_DIR) $(APPLICATION_PLANE_DIR)

# Emulator config
CLOUD_EMULATOR ?= kumo
EMULATOR_ENDPOINT := http://localhost:4566
DYNAMODB_LOCAL_ENDPOINT := http://localhost:8000
LOCAL_TABLE := TenkaCloud-local

######## Setup ########

#? install: Install all dependencies
install:
	@$(BUN) install
	@for app in $(FRONTEND_APPS); do (cd $$app && $(BUN) install) || exit 1; done

#? install_ci: Install dependencies for CI (frozen lockfile, no scripts)
install_ci:
	@$(BUN) run install:ci
	@for app in $(FRONTEND_APPS); do (cd $$app && $(BUN) install --frozen-lockfile --ignore-scripts) || exit 1; done

######## Development ########

#? start: Start everything (emulator + DynamoDB + all dev servers)
start:
	@docker --version > /dev/null 2>&1 || { echo "Docker is not running"; exit 1; }
	@command -v aws >/dev/null 2>&1 || { echo "AWS CLI not installed: brew install awscli"; exit 1; }
	@CLOUD_EMULATOR=$(CLOUD_EMULATOR) ./scripts/local-setup.sh
	@echo ""
	@echo "  Control Plane:      http://localhost:13000/control"
	@echo "  Application Plane:  http://localhost:13001/"
	@echo "  Tenant API:         http://localhost:13004/api/tenants"
	@echo "  Cloud Emulator:     http://localhost:4566"
	@echo "  DynamoDB Local:     http://localhost:8000"
	@echo ""
	@DYNAMODB_ENDPOINT=$(DYNAMODB_LOCAL_ENDPOINT) \
	DYNAMODB_TABLE=$(LOCAL_TABLE) \
	DYNAMODB_TABLE_NAME=$(LOCAL_TABLE) \
	AWS_REGION=ap-northeast-1 \
	AWS_ACCESS_KEY_ID=test \
	AWS_SECRET_ACCESS_KEY=test \
	AWS_ENDPOINT_URL=$(EMULATOR_ENDPOINT) \
	EVENT_BUS_NAME=tenkacloud-local-tenant-events \
	DATA_BUCKET_NAME=tenkacloud-local-data \
	PROVISIONING_ENABLED=true \
	PROVISIONING_DELIVERY_MODE=inline \
	TENANT_API_BASE_URL=http://localhost:13004/api \
	AUTH_SECRET=local-dev-secret-do-not-use-in-production \
	AUTH_SKIP=1 \
	AUTH_SKIP_ROLES=participant \
	NEXT_PUBLIC_AUTH_SKIP=1 \
	NEXT_PUBLIC_APPLICATION_PLANE_URL=http://localhost:13001 \
	$(NR) dev

#? stop: Stop all services
stop:
	@docker compose --profile localstack --profile kumo --profile floci stop 2>/dev/null || true
	@lsof -ti:13000,13001,13004 2>/dev/null | xargs kill -9 2>/dev/null || true
	@echo "Stopped."

#? restart: Restart all services
restart: stop start

#? status: Show service status
status:
	@docker compose ps 2>/dev/null || echo "No containers running"

#? start-aws: Start with real AWS (requires: source scripts/aws-creds.sh)
start-aws:
	@[ -n "$$AWS_SESSION_TOKEN" ] || { echo "Run: source scripts/aws-creds.sh"; exit 1; }
	@docker compose -f docker-compose.yml -f docker-compose.aws.yml up -d --build

######## Quality ########

#? test: Run tests with coverage
test:
	@for app in $(FRONTEND_APPS); do (cd $$app && $(NR) test:coverage) || exit 1; done

#? test_quick: Run tests without coverage (fast)
test_quick:
	@for app in $(FRONTEND_APPS); do (cd $$app && $(NR) test) || exit 1; done

#? test_e2e: Run E2E tests (Playwright)
test_e2e:
	@cd $(CONTROL_PLANE_DIR) && $(BUN)x nlx playwright install chromium --with-deps && $(NR) test:e2e

#? before-commit: Run all quality checks
before-commit:
	@$(BUN) run lint_text
	@$(BUN) run format_check
	@for app in $(FRONTEND_APPS); do (cd $$app && $(NR) typecheck) || exit 1; done
	@for app in $(FRONTEND_APPS); do (cd $$app && $(NR) test:coverage) || exit 1; done
	@for app in $(FRONTEND_APPS); do \
		(cd $$app && NEXT_TELEMETRY_DISABLED=1 SKIP_AUTH0_VALIDATION=1 \
		AUTH0_CLIENT_ID=dummy AUTH0_CLIENT_SECRET=dummy AUTH0_ISSUER=https://example.com \
		$(NR) build) || exit 1; \
	done
	@echo "All checks passed."

#? build: Production build
build:
	@for app in $(FRONTEND_APPS); do \
		(cd $$app && NEXT_TELEMETRY_DISABLED=1 SKIP_AUTH0_VALIDATION=1 \
		AUTH0_CLIENT_ID=dummy AUTH0_CLIENT_SECRET=dummy AUTH0_ISSUER=https://example.com \
		$(NR) build) || exit 1; \
	done

######## Data ########

#? seed: Initialize DB tables and seed demo data
seed:
	@./scripts/init-dynamodb-tables.sh
	@./scripts/seed-data.sh
	@./scripts/gameday-seed.sh

######## Help ########

#? help: Show available commands
help: Makefile
	@echo ''
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@sed -n 's/^#?//p' $< | column -t -s ':' | sort | sed -e 's/^/ /'
	@echo ''
	@echo 'Options:'
	@echo '  CLOUD_EMULATOR=kumo|localstack|floci  (default: kumo)'
