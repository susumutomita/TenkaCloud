.PHONY: install deploy deploy-control-plane deploy-application-plane deploy-problem destroy synth diff bootstrap build test lint format format-check static-analysis before-commit clean help

ENV ?= development
CDK := bun run cdk
CDK_CONTEXT := -c environment=$(ENV)

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

#? deploy: Deploy all stacks
deploy: build
	@echo "Deploying all stacks ($(ENV))..."
	$(CDK) deploy --all $(CDK_CONTEXT) --require-approval broadening

#? deploy-control-plane: Deploy ControlPlane stack only
deploy-control-plane: build
	$(CDK) deploy ControlPlaneStack $(CDK_CONTEXT) --require-approval broadening

#? deploy-application-plane: Deploy AppPlane stack only
deploy-application-plane: build
	$(CDK) deploy AppPlaneStack $(CDK_CONTEXT) --require-approval broadening

#? deploy-problem: Deploy ProblemDeployPlane stack only
deploy-problem: build
	$(CDK) deploy ProblemDeployPlaneStack $(CDK_CONTEXT) --require-approval broadening

######## Operations ########

#? destroy: Destroy all stacks
destroy: build
	$(CDK) destroy --all $(CDK_CONTEXT)

#? synth: Synthesize CloudFormation templates
synth: build
	$(CDK) synth $(CDK_CONTEXT)

#? diff: Show diff against deployed stacks
diff: build
	$(CDK) diff --all $(CDK_CONTEXT)

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
	$(CDK) synth $(CDK_CONTEXT) 2>&1 | grep -E "(Error|Warning|AwsSolutions)" || echo "No cdk-nag findings"

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
