.PHONY: help install setup_husky clean lint lint_text format format_check before_commit before-commit start test test_coverage dev build

# デフォルトターゲットはhelp
default: help

# bun run を実行するターゲット
NPM_RUN_TARGETS = clean lint lint_text format format_check typecheck test dev build

$(NPM_RUN_TARGETS):
	bun run $@

install:
	bun install

install_ci:
	bun run install:ci

setup_husky:
	bun run husky

before_commit: lint_text format_check

# ハイフン付きのエイリアス（打ち間違え対策）
before-commit: before_commit

start:
	bun start

test_coverage:
	bun run test:coverage

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  install         Install bun packages"
	@echo "  clean           Clean the project"
	@echo "  setup_husky     Setup Husky"
	@echo "  lint            Run linter"
	@echo "  lint_text       Run textlint"
	@echo "  typecheck       Run TypeScript type checking"
	@echo "  format          Format code"
	@echo "  format_check    Check code formatting"
	@echo "  before_commit   Run checks before commit"
	@echo "  dev             Start development server"
	@echo "  build           Build the project"
	@echo "  start           Start app"
	@echo "  test            Run tests"
	@echo "  test_coverage   Run tests with coverage report"
	@echo "  help            Show this help message"
