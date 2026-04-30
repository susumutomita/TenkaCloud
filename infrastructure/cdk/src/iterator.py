# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Step Function iterator — advances the wave cursor between batched deploys.

def lambda_handler(event, context):
    iterator = event.get("iterator", {})
    index = iterator.get("index", 0) + 1
    count = iterator.get("count", 0)
    return {
        "index": index,
        "count": count,
        "continue": index < count,
    }
