.PHONY: install deploy deploy-control-plane deploy-application-plane deploy-problem destroy destroy-control-plane destroy-application-plane destroy-problem synth diff bootstrap build test lint format format-check static-analysis before-commit clean help

ENV ?= development
TENKACLOUD_ROOT := $(abspath $(CURDIR)/../..)
DEPLOY_ENV_FILE := $(TENKACLOUD_ROOT)/infrastructure/cdk/environments/$(ENV)/.env
DEPLOY_SCRIPT := $(TENKACLOUD_ROOT)/scripts/install.sh
CDK := bun run cdk
CDK_CONTEXT := -c environment=$(ENV)

# CDK の bin/cdk.ts は CDK_PARAM_SYSTEM_ADMIN_EMAIL を必須、CDK_PARAM_S3_BUCKET_NAME /
# CDK_SOURCE_NAME / CDK_PARAM_COMMIT_ID を getEnv() で要求する。deploy は install.sh で
# 全部 export してくるが、destroy / synth / diff など install.sh を経由しないターゲットは
# .env 由来で SYSTEM_ADMIN_EMAIL を読み、他はプレースホルダで埋めて synth/destroy を通す。
# 各レシピ先頭で `$(CDK_ENV_EXPORTS); ...` のように使う。
CDK_ENV_EXPORTS = \
	if [ ! -f "$(DEPLOY_ENV_FILE)" ]; then echo "ERROR: $(DEPLOY_ENV_FILE) not found"; exit 1; fi; \
	SYSTEM_ADMIN_EMAIL="$$(grep '^SYSTEM_ADMIN_EMAIL=' "$(DEPLOY_ENV_FILE)" | head -n 1 | cut -d= -f2-)"; \
	if [ -z "$$SYSTEM_ADMIN_EMAIL" ]; then echo "ERROR: SYSTEM_ADMIN_EMAIL missing in $(DEPLOY_ENV_FILE)"; exit 1; fi; \
	export CDK_PARAM_SYSTEM_ADMIN_EMAIL="$$SYSTEM_ADMIN_EMAIL"; \
	export CDK_PARAM_ENVIRONMENT="$(ENV)"; \
	export CDK_PARAM_S3_BUCKET_NAME="$${CDK_PARAM_S3_BUCKET_NAME:-tenkacloud-cdk-placeholder}"; \
	export CDK_SOURCE_NAME="$${CDK_SOURCE_NAME:-source.zip}"; \
	export CDK_PARAM_COMMIT_ID="$${CDK_PARAM_COMMIT_ID:-placeholder}"; \
	export JSII_DEPRECATED=quiet

default: help

######## Setup ########

#? install: Install dependencies
install:
	@bun install

#? bootstrap: Run CDK bootstrap (first time only)
bootstrap: install
	@echo "CDK bootstrap for $(ENV)..."
	$(CDK) bootstrap $(CDK_CONTEXT)

#? build: Build TypeScript
build: install
	@bun run build

#? clean: Remove build artifacts
clean:
	@rm -rf dist cdk.out

######## Deploy ########

#? deploy: Deploy all stacks (delegates to scripts/install.sh)
deploy:
	@if [ ! -f "$(DEPLOY_ENV_FILE)" ]; then \
		echo "ERROR: $(DEPLOY_ENV_FILE) not found"; \
		exit 1; \
	fi
	@SYSTEM_ADMIN_EMAIL="$$(grep '^SYSTEM_ADMIN_EMAIL=' "$(DEPLOY_ENV_FILE)" | head -n 1 | cut -d= -f2-)"; \
	if [ -z "$$SYSTEM_ADMIN_EMAIL" ]; then \
		echo "ERROR: SYSTEM_ADMIN_EMAIL is missing in $(DEPLOY_ENV_FILE)"; \
		exit 1; \
	fi; \
	export CDK_PARAM_ENVIRONMENT="$(ENV)"; \
	cd "$(TENKACLOUD_ROOT)/scripts" && bash ./install.sh "$$SYSTEM_ADMIN_EMAIL"

#? deploy-control-plane: Deploy ControlPlane stack only
deploy-control-plane: build
	@$(CDK_ENV_EXPORTS); $(CDK) deploy ControlPlaneStack $(CDK_CONTEXT) --require-approval broadening

#? deploy-application-plane: Deploy AppPlane stack only
deploy-application-plane: build
	@$(CDK_ENV_EXPORTS); $(CDK) deploy AppPlaneStack $(CDK_CONTEXT) --require-approval broadening

#? deploy-problem: Deploy ProblemDeployPlane stack only
deploy-problem: build
	@$(CDK_ENV_EXPORTS); $(CDK) deploy ProblemDeployPlaneStack $(CDK_CONTEXT) --require-approval broadening

######## Operations ########

#? destroy: Destroy all stacks
destroy: build
	@$(CDK_ENV_EXPORTS); $(CDK) destroy --all $(CDK_CONTEXT)

#? destroy-control-plane: Destroy ControlPlane stack only
destroy-control-plane: build
	@$(CDK_ENV_EXPORTS); $(CDK) destroy ControlPlaneStack $(CDK_CONTEXT)

#? destroy-application-plane: Destroy AppPlane stack only
destroy-application-plane: build
	@$(CDK_ENV_EXPORTS); $(CDK) destroy AppPlaneStack $(CDK_CONTEXT)

#? destroy-problem: Destroy ProblemDeployPlane stack only
destroy-problem: build
	@$(CDK_ENV_EXPORTS); $(CDK) destroy ProblemDeployPlaneStack $(CDK_CONTEXT)

#? synth: Synthesize CloudFormation templates
synth: build
	@$(CDK_ENV_EXPORTS); $(CDK) synth $(CDK_CONTEXT)

#? diff: Show diff against deployed stacks
diff: build
	@$(CDK_ENV_EXPORTS); $(CDK) diff --all $(CDK_CONTEXT)

######## Quality ########

#? test: Run CDK tests
test: install
	@bun run test

#? lint: Run linter
lint: install
	@bun run lint

#? format: Auto-format code
format: install
	@bun run format

#? format-check: Check formatting without modifying files
format-check: install
	@bun run format:check

#? static-analysis: Run cdk-nag security checks via synth
static-analysis: build
	@echo "Running cdk-nag static analysis..."
	@$(CDK_ENV_EXPORTS); $(CDK) synth $(CDK_CONTEXT) 2>&1 | grep -E "(Error|Warning|AwsSolutions)" || echo "No cdk-nag findings"

#? before-commit: Run all quality checks (lint + format + test + static-analysis)
before-commit: lint format-check test static-analysis
	@echo "All checks passed."

######## Help ########

#? help: Show available commands
help: Makefile
	@echo ''
	@echo 'Usage:'
	@echo '  make [target] ENV=development|staging|production'
	@echo ''
	@echo 'Environment:'
	@echo '  ENV                        Target environment (default: development)'
	@echo '  environments/{ENV}/.env    Must exist with AWS_ACCOUNT_ID, SYSTEM_ADMIN_EMAIL'
	@echo ''
	@echo 'Targets:'
	@sed -n 's/^#?//p' $< | column -t -s ':' | sort | sed -e 's/^/ /'
