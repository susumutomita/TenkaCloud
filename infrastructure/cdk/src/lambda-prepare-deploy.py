# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# CodePipeline LambdaInvokeAction handler.
#
# Reads the TenantMappingTable to enumerate tenant stacks that need updating,
# emits an output.json manifest describing the deployment waves, and uploads it
# as the output artifact for the next pipeline stage (Step Function deploy).

import json
import os
import tempfile
import zipfile
from urllib.parse import urlparse

import boto3

s3 = boto3.client("s3")
dynamodb = boto3.client("dynamodb")
codepipeline = boto3.client("codepipeline")

BUCKET = os.environ["BUCKET"]
TENANT_MAPPING_TABLE = os.environ["TENANT_MAPPING_TABLE"]


def _scan_tenants():
    tenants = []
    paginator = dynamodb.get_paginator("scan")
    for page in paginator.paginate(TableName=TENANT_MAPPING_TABLE):
        for item in page.get("Items", []):
            tenants.append({k: list(v.values())[0] for k, v in item.items()})
    return tenants


def _build_waves(tenants):
    # Single-wave layout — every tenant updates in parallel. SaaS Factory's
    # ref impl batches by tier, but TenkaCloud is pooled-only today so a flat
    # list keeps the Step Function input minimal.
    return [{"waveNumber": 1, "tenants": tenants}]


def _put_output_artifact(job_data, payload):
    output_artifact = job_data["outputArtifacts"][0]
    s3_loc = output_artifact["location"]["s3Location"]
    bucket = s3_loc["bucketName"]
    key = s3_loc["objectKey"]

    encryption_key = job_data.get("encryptionKey")
    extra_args = {}
    if encryption_key and encryption_key.get("type") == "KMS":
        extra_args = {
            "ServerSideEncryption": "aws:kms",
            "SSEKMSKeyId": encryption_key["id"],
        }

    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("output.json", json.dumps(payload))
        s3.upload_file(tmp.name, bucket, key, ExtraArgs=extra_args)


def lambda_handler(event, context):
    job = event["CodePipeline.job"]
    job_id = job["id"]
    job_data = job["data"]

    try:
        user_params = json.loads(
            job_data["actionConfiguration"]["configuration"]["UserParameters"]
        )
        tenants = _scan_tenants()
        waves = _build_waves(tenants)

        payload = {
            "iterator": {"index": 0, "count": len(waves), "continue": len(waves) > 0},
            "waves": waves,
            "artifact": user_params.get("artifact"),
            "s3SourceVersionId": user_params.get("s3_source_version_id"),
        }

        _put_output_artifact(job_data, payload)
        codepipeline.put_job_success_result(jobId=job_id)
    except Exception as exc:  # noqa: BLE001
        codepipeline.put_job_failure_result(
            jobId=job_id,
            failureDetails={"message": str(exc)[:265], "type": "JobFailed"},
        )
        raise

    return "ok"
