.PHONY: install dev start build preview test clean help

default: help

#? install: 依存パッケージをインストール
install:
	bun install

#? dev: 開発サーバ起動 (http://localhost:5175)
dev:
	bun run dev

#? start: 本番ビルドをローカルで serve
start: build preview

#? build: 型チェック + Vite ビルド
build:
	bun run build

#? preview: build 後の dist/ を serve
preview:
	bun run preview

#? test: vitest
test:
	bun run test

#? clean: git ignore 対象 (dist / node_modules / coverage 等) を削除
# CLAUDE.md で `rm` は禁止のため、ignore 対象だけ消す `git clean -fdX` を使う。
clean:
	git clean -fdX

#? help: 使えるターゲット一覧
help: Makefile
	@echo ''
	@echo 'Usage: make [target]'
	@echo ''
	@sed -n 's/^#?//p' $< | column -t -s ':' | sort | sed -e 's/^/ /'
