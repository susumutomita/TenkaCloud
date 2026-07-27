#!/usr/bin/env bash
set -euo pipefail

# The normal checkout hoists aws-cdk to the repository root, while a packaged
# source bundle installs it inside the renamed `cdk` workspace. Resolve only
# those two dependency-owned locations so PATH or a globally installed CLI can
# never silently select an incompatible cloud-assembly schema.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_CANDIDATES=(
  "${SCRIPT_DIR}/../node_modules/aws-cdk/bin/cdk"
  "${SCRIPT_DIR}/../cdk/node_modules/aws-cdk/bin/cdk"
)

for candidate in "${CDK_CANDIDATES[@]}"; do
  if [[ -x "${candidate}" ]]; then
    exec "${candidate}" "$@"
  fi
done

echo "ERROR: repository-local aws-cdk CLI is not installed; run bun install first." >&2
exit 1
