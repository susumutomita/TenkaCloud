#!/usr/bin/env bash
# destroy-battles.sh — deploy-battles.sh で立てた CFn stack を順次 delete する。
#
# Usage:
#   bash scripts/destroy-battles.sh <problem-dir> [<problem-dir> ...]
#
# 環境変数:
#   TEAM_SLUG     deploy-battles.sh と同じ値を指定する。default: "demo-team"
#   AWS_REGION    deploy 先 region。default: aws cli config から取得
#   WAIT_FOR_DELETE  "true" にすると DELETE_COMPLETE まで待機。default: "false" (非同期)
#
# 例:
#   bash scripts/destroy-battles.sh problems/gameday/security-battle-royale
#   WAIT_FOR_DELETE=true bash scripts/destroy-battles.sh problems/gameday/security-battle-royale

set -euo pipefail

# shellcheck source=lib/battles-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/battles-common.sh"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <problem-dir> [<problem-dir> ...]" >&2
  exit 1
fi

TEAM_SLUG="${TEAM_SLUG:-demo-team}"
AWS_REGION="$(resolve_aws_region)"
WAIT_FOR_DELETE="${WAIT_FOR_DELETE:-false}"

destroy_one() {
  local problem_dir="$1"
  local name_prefix
  name_prefix="$(build_name_prefix "${problem_dir}" "${TEAM_SLUG}")"

  echo ""
  echo "=========================================="
  echo "Deleting: ${name_prefix} (region: ${AWS_REGION})"
  echo "=========================================="

  # delete-stack は stack が無くてもエラーにならない (CFn の挙動)。
  aws cloudformation delete-stack \
    --region "${AWS_REGION}" \
    --stack-name "${name_prefix}"

  if [[ "${WAIT_FOR_DELETE}" == "true" ]]; then
    echo "Waiting for DELETE_COMPLETE..."
    aws cloudformation wait stack-delete-complete \
      --region "${AWS_REGION}" \
      --stack-name "${name_prefix}"
    echo "  → DELETE_COMPLETE"
  else
    echo "  → DELETE 要求送信済 (非同期)。完了確認は AWS Console か WAIT_FOR_DELETE=true で再実行"
  fi
}

failures=()
for problem_dir in "$@"; do
  problem_dir="${problem_dir%/}"
  if ! destroy_one "${problem_dir}"; then
    failures+=("${problem_dir}")
  fi
done

echo ""
echo "=========================================="
if [[ ${#failures[@]} -eq 0 ]]; then
  echo "All $# delete request(s) issued."
  exit 0
else
  echo "Failed delete requests (${#failures[@]} of $#):"
  for f in "${failures[@]}"; do
    echo "  - ${f}"
  done
  exit 1
fi
