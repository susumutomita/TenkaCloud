#!/bin/bash
# CodeBuild の provision-tenant.sh / update-tenant.sh で source する Node セットアップ helper。
#
# `.nvmrc` を読んで NodeSource yum repo から install する。
#
# Why NodeSource: image 非依存で動く (AL2 / AL2023 / standard:7.0)。CodeBuild image に
# nvm が無いケースで silent fail した旧 nvm 経路 (#560) の置換。
# Why .nvmrc 経由: バージョン値を repo root の 1 ファイルに集約し、ローカル dev (`nvm use`)
# と CodeBuild で同じ version を使う。
# Why pipefail: caller 側で `set -o pipefail` を有効化していること前提。`curl ... | sudo bash -`
# の途中失敗を取りこぼさないため。

install_node_from_nvmrc() {
  local node_major
  # `.nvmrc` は `20` / `20.11` / `v20.11.1` のいずれの nvm 互換形式でも受ける。
  # whitespace と leading `v` を strip → major を取り、numeric 検証 (= setup_v20.x のような不正 URL 構築を防ぐ)。
  node_major="$(tr -d '[:space:]' < .nvmrc | sed -E 's/^v//' | cut -d. -f1)"
  if ! [[ "$node_major" =~ ^[0-9]+$ ]]; then
    echo "Invalid .nvmrc format: expected '20' / '20.11' / 'v20.11.1' style" >&2
    return 1
  fi
  curl -fsSL "https://rpm.nodesource.com/setup_${node_major}.x" | sudo bash -
  sudo yum install -y nodejs
  node --version
  npm --version
}
