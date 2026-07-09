# CCoE LT deck — presentation launcher
#
#   make present  既定ブラウザで開く
#   make pdf      ブラウザの印刷ダイアログからPDF保存

MKFILE_DIR := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))
INDEX      := file://$(MKFILE_DIR)index.html

.DEFAULT_GOAL := help
.PHONY: present pdf help

## 既定ブラウザで開く
present:
	@open "$(INDEX)"

## 印刷ダイアログ経由でPDF保存
pdf:
	@open "$(INDEX)"
	@echo "ブラウザで印刷 → PDF として保存"

help:
	@echo "CCoE LT deck:"
	@echo "  make present  既定ブラウザで開く"
	@echo "  make pdf      PDF として保存"
