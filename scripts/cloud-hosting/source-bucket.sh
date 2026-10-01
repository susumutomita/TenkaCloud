#!/usr/bin/env bash
# Require both the canonical installation name and purpose tags before any mutation.
tc_ensure_source_bucket() {
  local bucket="$1" account="$2" region="$3" environment="$4" script_dir="$5"
  local canonical head_error tags
  canonical="$(tc_source_bucket_name "${account}" "${region}" "${environment}")"
  if [ "${bucket}" != "${canonical}" ]; then
    echo "Refusing an unrelated source bucket; expected ${canonical}" >&2; return 1
  fi
  if head_error="$(aws s3api head-bucket --bucket "${bucket}" --expected-bucket-owner "${account}" 2>&1)"; then
    tags="$(aws s3api get-bucket-tagging --bucket "${bucket}" --expected-bucket-owner "${account}" --output json)" || return 1
    printf '%s' "${tags}" | python3 "${script_dir}/validate-source-bucket.py" "${account}" "${environment}" || return 1
  else
    case "${head_error}" in
      *"(404)"*|*"Not Found"*|*"NoSuchBucket"*) ;;
      *) echo "Source bucket ownership could not be verified: ${head_error}" >&2; return 1 ;;
    esac
    if [ "${region}" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "${bucket}" || return 1
    else
      aws s3api create-bucket --bucket "${bucket}" --region "${region}" --create-bucket-configuration "LocationConstraint=${region}" || return 1
    fi
    tags="$(python3 -c 'import json,sys;print(json.dumps({"TagSet":[{"Key":k,"Value":v} for k,v in {"TenkaCloudProject":"cloud-hosting","TenkaCloudPurpose":"source-bundle","TenkaCloudAccount":sys.argv[1],"Environment":sys.argv[2]}.items()]}))' "${account}" "${environment}")"
    aws s3api put-bucket-tagging --bucket "${bucket}" --expected-bucket-owner "${account}" --tagging "${tags}" || return 1
    aws s3api put-public-access-block --bucket "${bucket}" --expected-bucket-owner "${account}" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true || return 1
  fi
}
