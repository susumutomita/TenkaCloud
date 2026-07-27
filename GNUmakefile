# GNU make loads this file before Makefile. Keep the existing Makefile as the
# product build source of truth and expose repository-local Symphony commands.
include Makefile

SYMPHONY_BIN ?= symphony
SYMPHONY_WORKFLOW ?= .symphony/WORKFLOW.md
SYMPHONY_PORT ?= 4311
SYMPHONY_LOGS_ROOT ?= .symphony/logs

.PHONY: agent-gate symphony-validate symphony-print symphony-run

agent-gate: ci-local symphony-validate

symphony-validate:
	@test -f "$(SYMPHONY_WORKFLOW)"
	@grep -q '^  kind: github$$' "$(SYMPHONY_WORKFLOW)"
	@grep -q '^    repo: susumutomita/TenkaCloud$$' "$(SYMPHONY_WORKFLOW)"
	@grep -q '^    - agent:ready$$' "$(SYMPHONY_WORKFLOW)"
	@grep -q 'make agent-gate' "$(SYMPHONY_WORKFLOW)"
	@grep -q 'codex exec review --base origin/main' "$(SYMPHONY_WORKFLOW)"
	@grep -q 'Never run deploy, destroy, release, force-push, or secret-management commands' "$(SYMPHONY_WORKFLOW)"

symphony-print: symphony-validate
	@cat "$(SYMPHONY_WORKFLOW)"

symphony-run: symphony-validate
	@test -n "$$GITHUB_TOKEN" || { echo 'GITHUB_TOKEN is required' >&2; exit 2; }
	@test -n "$$SYMPHONY_WORKSPACE_ROOT" || { echo 'SYMPHONY_WORKSPACE_ROOT is required' >&2; exit 2; }
	@mkdir -p "$(SYMPHONY_LOGS_ROOT)"
	"$(SYMPHONY_BIN)" "$(SYMPHONY_WORKFLOW)" --port "$(SYMPHONY_PORT)" --logs-root "$(SYMPHONY_LOGS_ROOT)"
