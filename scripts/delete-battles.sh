#!/usr/bin/env bash
# delete-battles.sh — 1 引数 (StackName) を受け取って CFn DeleteStack + Wait する。
# deploy-battles.sh と対称な操作。MVP-1 は same-account なので CodeBuild Project Role
# が直接 CFn DeleteStack 権限を持つ。Phase 2 (cross-account) では sts:AssumeRole に
# 差し替える。

set -euo pipefail

# shellcheck source=lib/battles-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/battles-common.sh"

# #3063: 元は無条件で en_US.UTF-8 を強制していた。その locale が generate されていない
# image では `setlocale: LC_ALL: cannot change locale` 警告が以後の bash 子プロセス全部の
# stderr に出続け、下の STS account 比較を汚染する一因になった (詳細は #3063 参照)。
# 必要なのは「ASCII-only な C/POSIX/未設定を UTF-8 な locale に倒す」ことだけで en_US で
# ある必然性はないので、`locale -a` に実在する候補だけを使う。en_US.UTF-8 (これまでの
# 既定・大半の image で generate 済) → C.UTF-8 → C.utf8 (どちらも glibc 組込みで
# generate 不要。ディストリごとの綴り違いを両方試す) の順。どれも無ければ強制しない
# (= 警告は出ないが元の locale のまま; UTF-8 mojibake 対策より「壊れた delete」の方が害が大きい)。
case "${LC_ALL:-${LANG:-}}" in
  C|POSIX|"")
    available_locales="$(locale -a 2>/dev/null || true)"
    utf8_locale=""
    for candidate in en_US.UTF-8 C.UTF-8 C.utf8; do
      if grep -qxF "${candidate}" <<<"${available_locales}"; then
        utf8_locale="${candidate}"
        break
      fi
    done
    if [[ -n "${utf8_locale}" ]]; then
      export LANG="${utf8_locale}"
      export LC_ALL="${utf8_locale}"
    fi
    unset available_locales utf8_locale candidate
    ;;
esac

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <stack-name-or-arn> [<region>]" >&2
  exit 1
fi

STACK_NAME="$1"
# 第 2 引数 > AWS_REGION env > aws cli config の順 (resolve_aws_region は env/cli config を見る)。
REGION="${2:-$(resolve_aws_region)}"

# Phase 2.2 (Issue #459): cross-account 化。`COMPETITOR_ROLE_ARN` が set されていれば
# AssumeRole + ExternalId で tmp credentials に切り替える。
# DEPLOY_REGION も export し直す (delete でも target region を AssumeRole 後に固定する)。
export DEPLOY_REGION="${REGION}"
assume_competitor_role_if_configured
trace_log "deploy.codebuild.start" operation "delete" region "${REGION}" stackName "${STACK_NAME}"

# #1797: credentials が「stack の実在する account」を指しているかを delete-stack の前に検証。
# 別 account を指したまま進むと delete-stack は no-op 成功 / wait も成功扱いになり、
# DB は DELETED なのに実 stack が CREATE_COMPLETE で残存する silent leak になる。
# State Machine 経由は常に DELETE_EXPECTED_AWS_ACCOUNT_ID が入る (欠損 event は SFN 側の
# isPresent ガードで markFailed)。未設定で skip するのは手動実行 (運営 recovery) のみ。
if [[ -n "${DELETE_EXPECTED_AWS_ACCOUNT_ID:-}" ]]; then
  # #3063: 値 (stdout) と診断 (stderr) を別々に受ける。以前は `2>&1` で 1 変数に
  # まとめており、成功時でも stderr に出た無関係な 1 行 (locale 警告、aws CLI の
  # deprecation notice 等) が account ID へ混入し、一致している account を mismatch
  # と誤判定して正しい delete を拒否していた。set -e 下で command substitution が
  # 黙って死なないよう、STS 失敗時の診断は sts_stderr_file 経由で trace に載せる
  # (2>&1 で得ていた「失敗理由を trace へ載せる」という意図はここに残す)。
  sts_stderr_file="$(mktemp)"
  if ! ACTUAL_AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>"${sts_stderr_file}")"; then
    sts_stderr="$(cat "${sts_stderr_file}")"
    rm -f "${sts_stderr_file}"
    trace_log "deploy.cfn.delete.failed" stackName "${STACK_NAME}" region "${REGION}"
    echo "error: sts get-caller-identity failed (credential / STS availability): ${sts_stderr}" >&2
    exit 1
  fi
  rm -f "${sts_stderr_file}"
  if [[ "${ACTUAL_AWS_ACCOUNT_ID}" != "${DELETE_EXPECTED_AWS_ACCOUNT_ID}" ]]; then
    trace_log "deploy.cfn.delete.account_mismatch" stackName "${STACK_NAME}" region "${REGION}" \
      expectedAccount "${DELETE_EXPECTED_AWS_ACCOUNT_ID}" actualAccount "${ACTUAL_AWS_ACCOUNT_ID}"
    echo "error: credentials are for account ${ACTUAL_AWS_ACCOUNT_ID} but stack ${STACK_NAME} lives in ${DELETE_EXPECTED_AWS_ACCOUNT_ID}; aborting before delete-stack (the stack would silently survive)" >&2
    exit 1
  fi
fi

echo "=========================================="
echo "Deleting stack"
echo "  StackName : ${STACK_NAME}"
echo "  Region    : ${REGION}"
echo "=========================================="
trace_log "deploy.cfn.delete.start" stackName "${STACK_NAME}" region "${REGION}"

# DeleteStack 自体が冪等 (削除済み stack に対して呼んでも ValidationError を返すだけで
# 既存リソースに影響なし)。pre-check の describe-stacks は TOCTOU race を生む (= check と
# delete の間に他 actor が消すと describe は OK でも delete が ValidationError) ので入れない。
# 直接 delete-stack → 既に削除済みなら "does not exist" を握って no-op exit、それ以外は loud に fail。
# #1381: same-account 経路では deploy 時と同じ CFn service role を渡す (= CodeBuild role から
# 直接の resource 削除権限を剥がした分、 CFn がこの role を assume して削除する)。 cross-account 経路は
# assumed competitor role の権限で動くため --role-arn は付けない。
cfn_delete_role_args=()
if [[ -z "${COMPETITOR_ROLE_ARN:-}" && -n "${CFN_EXEC_ROLE_ARN:-}" ]]; then
  cfn_delete_role_args=(--role-arn "${CFN_EXEC_ROLE_ARN}")
fi
delete_err="$(
  aws cloudformation delete-stack \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    ${cfn_delete_role_args[@]+"${cfn_delete_role_args[@]}"} 2>&1
)" || {
  if grep -qiE "ValidationError|does not exist" <<<"${delete_err}"; then
    trace_log "deploy.cfn.delete.already_deleted" stackName "${STACK_NAME}" region "${REGION}"
    echo "Stack ${STACK_NAME} は既に存在しない (already deleted) → no-op で終了"
    exit 0
  fi
  trace_log "deploy.cfn.delete.failed" stackName "${STACK_NAME}" region "${REGION}"
  echo "error: delete-stack failed (auth/throttle/network 等を疑う): ${delete_err}" >&2
  exit 1
}

# DeleteStack は async。完了 (= DescribeStacks が ValidationError を返す) まで wait。
# 60 minutes timeout (CodeBuild Project の build timeout と揃える)。
# 既削除の race (wait より先に消えた) も ValidationError として握る。
wait_err="$(
  aws cloudformation wait stack-delete-complete \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" 2>&1
)" || {
  if grep -qiE "ValidationError|does not exist" <<<"${wait_err}"; then
    trace_log "deploy.cfn.delete.already_deleted" stackName "${STACK_NAME}" region "${REGION}"
    echo "Stack ${STACK_NAME} は既に削除済 (wait の前に消えた) → no-op で終了"
    exit 0
  fi
  trace_log "deploy.cfn.delete.failed" stackName "${STACK_NAME}" region "${REGION}"
  echo "error: wait stack-delete-complete failed: ${wait_err}" >&2
  exit 1
}

echo ""
trace_log "deploy.cfn.delete.succeeded" stackName "${STACK_NAME}" region "${REGION}"
trace_log "deploy.codebuild.succeeded" operation "delete" region "${REGION}" stackName "${STACK_NAME}"
echo "Stack ${STACK_NAME} deleted (region=${REGION})."
