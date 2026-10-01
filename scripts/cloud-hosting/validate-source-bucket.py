"""Validate installation and purpose tags before modifying an existing source bucket."""
import json
import sys

data = json.load(sys.stdin)
tags = {entry["Key"]: entry["Value"] for entry in data.get("TagSet", [])}
expected = {
    "TenkaCloudProject": "cloud-hosting",
    "TenkaCloudPurpose": "source-bundle",
    "TenkaCloudAccount": sys.argv[1],
    "Environment": sys.argv[2],
}
if any(tags.get(key) != value for key, value in expected.items()):
    raise SystemExit("Source bucket ownership/purpose tags do not match; refusing adoption or retention changes")
