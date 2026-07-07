# TenkaCloud pitch deck — presentation launcher
#
#   make open     キオスクモード（UI ゼロ全画面）で起動。終了は Cmd+Q
#   make present  既定ブラウザで開く（全画面は F キー / ⌃⌘F）
#   make dia      Dia で開く（開いたら F キーで全画面）
#   make pdf      印刷ダイアログを開く（PDF として保存。デモのアニメは静止）

MKFILE_DIR    := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))
INDEX         := file://$(MKFILE_DIR)index.html
KIOSK_PROFILE := /tmp/tenkacloud-kiosk

.DEFAULT_GOAL := help
.PHONY: open present dia pdf help

## キオスクモード（タブもアドレスバーも無い全画面）。送り: ↓/Space、終了: Cmd+Q
open:
	@echo "Launching kiosk… 送り: ↓/Space  ·  終了: Cmd+Q"
	@open -na "Google Chrome" --args --kiosk --user-data-dir="$(KIOSK_PROFILE)" "$(INDEX)"

## 既定ブラウザで開く（F キーまたは ⌃⌘F で全画面）
present:
	@open "$(INDEX)"

## Dia で開く（開いたらスライドをクリック → F キーで全画面）
dia:
	@open -a Dia "$(INDEX)" || open "$(INDEX)"

## 印刷ダイアログ経由で PDF 保存（10 ページ／ライブデモは静止画）
pdf:
	@open "$(INDEX)"
	@echo "ブラウザで Cmd+P → 「PDF として保存」"

help:
	@echo "TenkaCloud pitch deck:"
	@echo "  make open     キオスク全画面で起動（終了 Cmd+Q）"
	@echo "  make present  既定ブラウザで開く（F / ⌃⌘F で全画面）"
	@echo "  make dia      Dia で開く（F キーで全画面）"
	@echo "  make pdf      PDF として保存（Cmd+P）"
