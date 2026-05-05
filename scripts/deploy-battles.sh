#!/usr/bin/env bash
# deploy-battles.sh — 引数に問題ディレクトリを受け取り、順次 CFn deploy する smoke test ツール。
#
# Usage:
#   bash scripts/deploy-battles.sh <problem-dir> [<problem-dir> ...]
#
# 環境変数:
#   TEAM_SLUG     チーム識別子。リソース名 prefix `tc-{problemSlug}-{teamSlug}` に使う。
#                 default: "demo-team"
#   AWS_REGION    deploy 先 region。default: aws cli config から取得
#   DB_PASSWORD   問題テンプレ (security-battle-royale 等) の DbPassword Parameter に渡す。
#                 未指定なら deploy ごとにランダム生成 (32 桁英数字)。secret を repo に残さない
#                 ため、固定値が必要なときは呼び出し側で `DB_PASSWORD=xxx make deploy-battles` を使う
#
# 例:
#   bash scripts/deploy-battles.sh problems/gameday/security-battle-royale
#   bash scripts/deploy-battles.sh problems/gameday/security-battle-royale problems/gameday/another
#   TEAM_SLUG=alpha bash scripts/deploy-battles.sh problems/gameday/security-battle-royale
#
# 設計意図:
#   ADR-001 の MVP-0 (PR-1.5) として、SaaS 配線 (Step Functions / EventBridge / tenant API /
#   Cognito) を一切持ち込まずに「CFn template と AWS 権限の正しさ」だけを smoke test する。
#   このスクリプトが安定すれば、MVP-1 では SBT ScriptJob パターン (Step Functions →
#   CodeBuild StartBuild .sync → 同 script 実行) で wrap するだけで済む。

set -euo pipefail

# shellcheck source=lib/battles-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/battles-common.sh"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <problem-dir> [<problem-dir> ...]" >&2
  echo "  e.g.: $0 problems/gameday/security-battle-royale" >&2
  exit 1
fi

TEAM_SLUG="${TEAM_SLUG:-demo-team}"
AWS_REGION="$(resolve_aws_region)"

deploy_one() {
  local problem_dir="$1"
  local template="${problem_dir}/template.yaml"
  if [[ ! -f "${template}" ]]; then
    echo "error: ${template} が見つかりません" >&2
    return 1
  fi

  local problem_slug
  problem_slug="$(basename "${problem_dir}")"
  local name_prefix
  name_prefix="$(build_name_prefix "${problem_dir}" "${TEAM_SLUG}")"

  echo ""
  echo "=========================================="
  echo "Deploying: ${problem_dir}"
  echo "  StackName : ${name_prefix}"
  echo "  Region    : ${AWS_REGION}"
  echo "  TeamSlug  : ${TEAM_SLUG}"
  echo "=========================================="

  # DbPassword は env DB_PASSWORD で渡す。未指定なら毎回ランダム生成 (smoke test なので
  # 永続性は不要)。secrets-in-source の commit を防ぐためハードコードしない。
  local db_password="${DB_PASSWORD:-}"
  if [[ -z "${db_password}" ]]; then
    # /dev/urandom を `tr` で英数字に絞って 32 桁切り出す。`head -c 32` が早期 close した
    # 際の `tr` への SIGPIPE で `set -o pipefail` が pipeline 全体を 141 で fail させる
    # ことがあるため、subshell で pipefail を局所的に無効化する (template の AllowedPattern
    # `^[A-Za-z0-9!@#$%^&*()_+\-=]+$` に収まる字種を選んでいる)。
    db_password="$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
  fi

  # `aws cloudformation deploy` は CreateStack / UpdateStack を冪等に扱う:
  #   - stack が無ければ Create
  #   - stack があれば Update (差分が無ければ "No changes" で 0 終了)
  #   - --no-fail-on-empty-changeset で「差分無し」を成功扱いにする (rerun 時の運用上の都合)
  aws cloudformation deploy \
    --region "${AWS_REGION}" \
    --stack-name "${name_prefix}" \
    --template-file "${template}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
        "NamePrefix=${name_prefix}" \
        "DbPassword=${db_password}" \
    --tags \
        "TenkaCloud:NamePrefix=${name_prefix}" \
        "TenkaCloud:Problem=${problem_slug}" \
        "TenkaCloud:TeamSlug=${TEAM_SLUG}" \
        "TenkaCloud:DeployedBy=deploy-battles.sh"

  # outputs を表示 (FrontendUrl 等が見える)
  echo ""
  echo "Outputs for ${name_prefix}:"
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${name_prefix}" \
    --query "Stacks[0].Outputs" \
    --output table
}

failures=()
for problem_dir in "$@"; do
  # 末尾のスラッシュを正規化
  problem_dir="${problem_dir%/}"
  if ! deploy_one "${problem_dir}"; then
    failures+=("${problem_dir}")
  fi
done

echo ""
echo "=========================================="
if [[ ${#failures[@]} -eq 0 ]]; then
  echo "All $# deploy(s) succeeded."
  exit 0
else
  echo "Failed deploys (${#failures[@]} of $#):"
  for f in "${failures[@]}"; do
    echo "  - ${f}"
  done
  exit 1
fi
