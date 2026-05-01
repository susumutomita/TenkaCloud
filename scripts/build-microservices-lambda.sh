#!/bin/bash
# Build each TenkaCloud microservice into a Lambda-ready bundle (dist/lambda/lambda.js).
#
# AdminApiStack reads from <service>/dist/lambda/. Each bundle is a single self-contained
# JS file that exports `handler` from the hono/aws-lambda adapter.
#
# Bun bundle (--target node) で全 dependency を 1 ファイルに焼く。Node built-ins は
# Lambda ランタイムが提供するので external のまま、aws-sdk v3 も Lambda image に含まれるので
# external 指定して bundle サイズを削る。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICES=(
  tenant-management
  problem-service
  gameday-service
  battle-service
  scoring-service
  leaderboard-service
)

# Bun bundle 時に external にするモジュール (Lambda runtime / node_modules で hot-load される)。
EXTERNAL_OPTS=(
  --external '@aws-sdk/*'
  --external 'aws-sdk'
)

build_one() {
  local svc="$1"
  local svc_dir="${ROOT_DIR}/server/microservices/${svc}"
  if [[ ! -f "${svc_dir}/src/lambda.ts" ]]; then
    echo "SKIP ${svc}: no src/lambda.ts" >&2
    return 0
  fi

  echo "Building ${svc} → dist/lambda/lambda.js"
  rm -rf "${svc_dir}/dist/lambda"
  mkdir -p "${svc_dir}/dist/lambda"

  (
    cd "${svc_dir}"
    bun build src/lambda.ts \
      --outdir dist/lambda \
      --target node \
      --minify \
      "${EXTERNAL_OPTS[@]}"
  )
}

# Build in parallel — each bun build is independent.
pids=()
for svc in "${SERVICES[@]}"; do
  build_one "${svc}" &
  pids+=("$!")
done

# wait for all to finish; fail if any fails.
status=0
for pid in "${pids[@]}"; do
  wait "${pid}" || status=$?
done

if [[ "${status}" -ne 0 ]]; then
  echo "One or more Lambda builds failed (last exit=${status})" >&2
  exit "${status}"
fi

echo "All Lambda bundles built."
