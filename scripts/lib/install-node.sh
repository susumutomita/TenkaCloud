#!/bin/bash
# CodeBuild の provision-tenant.sh / update-tenant.sh / deprovision-tenant.sh で source する runtime
# セットアップ helper。
#
# `.nvmrc` を読んで NodeSource (deb / rpm) repo から Node を install し、root package.json の
# `packageManager` から Bun version を読んで `bun` を使える状態にする。
#
# Why NodeSource: image 非依存で動く (AL2 / AL2023 / Ubuntu standard:5.0 / 7.0)。CodeBuild image
# に nvm が無いケースで silent fail した旧 nvm 経路 (#560) の置換。
# Why .nvmrc 経由: バージョン値を repo root の 1 ファイルに集約し、ローカル dev (`nvm use`)
# と CodeBuild で同じ version を使う。
# Why pipefail: caller 側で `set -o pipefail` を有効化していること前提。`curl ... | sudo bash -`
# の途中失敗を取りこぼさないため。
# Why OS detect: CodeBuild の LinuxBuildImage.STANDARD_5_0 は Ubuntu (deb) で
# `rpm.nodesource.com` が `This script is intended for RPM-based systems` で fail する。
# `apt-get` / `yum` (or `dnf`) のどちらが居るかで NodeSource URL とパッケージマネージャを切替える。

install_bun_from_package_manager() {
  local bun_version
  local installed_bun_version

  bun_version="$(node -e "const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); const match = String(pkg.packageManager || '').match(/^bun@(.+)$/); if (match) process.stdout.write(match[1]);")"
  if [ -z "$bun_version" ]; then
    echo "package.json must pin packageManager as bun@<version> for CodeBuild runtime setup." >&2
    return 1
  fi

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  installed_bun_version=""
  if command -v bun >/dev/null 2>&1; then
    installed_bun_version="$(bun --version)"
  fi

  if [ "$installed_bun_version" != "$bun_version" ]; then
    bash scripts/onboard/install-bun.sh "$bun_version"
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    hash -r 2>/dev/null || true
  fi

  bun --version
}

install_node_from_nvmrc() {
  local node_major
  # `.nvmrc` は `20` / `20.11` / `v20.11.1` のいずれの nvm 互換形式でも受ける。
  # whitespace と leading `v` を strip → major を取り、numeric 検証 (= setup_v20.x のような不正 URL 構築を防ぐ)。
  node_major="$(tr -d '[:space:]' < .nvmrc | sed -E 's/^v//' | cut -d. -f1)"
  if ! [[ "$node_major" =~ ^[0-9]+$ ]]; then
    echo "Invalid .nvmrc format: expected '20' / '20.11' / 'v20.11.1' style" >&2
    return 1
  fi

  if command -v apt-get >/dev/null 2>&1; then
    # deb 系 (= Ubuntu / Debian)。 NodeSource の deb setup script を使う。
    curl -fsSL "https://deb.nodesource.com/setup_${node_major}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    # rpm 系 (= Amazon Linux / RHEL / Fedora)。 NodeSource の rpm setup script を使う。
    curl -fsSL "https://rpm.nodesource.com/setup_${node_major}.x" | sudo bash -
    if command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y nodejs
    else
      sudo yum install -y nodejs
    fi
  else
    echo "Neither apt-get nor dnf/yum found. Cannot install Node.js." >&2
    return 1
  fi
  node --version
  npm --version
  install_bun_from_package_manager
}
