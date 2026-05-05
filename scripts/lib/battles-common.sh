#!/usr/bin/env bash
# battles-common.sh — deploy-battles.sh / destroy-battles.sh の共通ヘルパー。
#
# 使い方 (sibling script から source する):
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/battles-common.sh"

# stack 名 prefix の規約: `tc-{problemSlug}-{teamSlug}` (template.yaml の AllowedPattern
# `^tc-[a-z0-9]+(-[a-z0-9]+)+$` と一致)。同一 (Account, Region) に複数チームの問題スタックを
# 並べるための衝突回避 prefix。frontend (`apps/application-admin-console/src/lib/resource-naming.ts`)
# と backend (`infrastructure/lib/problem-deploy/handlers/deploy-handler/naming.ts`) でも
# 同じ規約を実装している (cross-language contract)。
build_name_prefix() {
  local problem_dir="$1"
  local team_slug="$2"
  local problem_slug
  problem_slug="$(basename "${problem_dir}")"
  echo "tc-${problem_slug}-${team_slug}"
}

# AWS region を解決。AWS_REGION env か aws cli config から取り、どちらも空ならエラー終了。
resolve_aws_region() {
  local region="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo "")}"
  if [[ -z "${region}" ]]; then
    echo "error: AWS_REGION 未設定。aws configure or 環境変数で指定してください" >&2
    return 1
  fi
  echo "${region}"
}
