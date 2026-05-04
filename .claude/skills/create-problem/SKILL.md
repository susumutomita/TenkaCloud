---
name: create-problem
description: Create a new TenkaCloud problem (GameDay or JAM) with the standard directory structure. Generates CloudFormation template, deploy script, and README.
---

Create a new TenkaCloud problem in the standard format under `problems/`. The user provides problem requirements; you scaffold all required files.

## Standard Directory Structure

All problems follow this layout regardless of type:

```
problems/{type}/{problem-name}/
├── README.md              # 必須: 問題説明・スコアリング・デプロイ手順
├── problem.yaml           # 必須: プラットフォーム用メタデータ（JAM のみ）
├── cloudformation/
│   └── {name}.yaml        # 必須: CloudFormation テンプレート（1ファイルで完結）
├── api/                   # 任意: サーバーサイドコード（GameDay で API サーバーが必要な場合）
├── frontend/              # 任意: 静的サイト（GameDay で S3 ウェブサイトが必要な場合）
└── scripts/
    └── deploy.sh          # 必須: デプロイスクリプト（./deploy.sh で動く）
```

## Step 1: Gather Requirements

Ask the user (or infer from context) the following:

1. **Type**: `gameday` or `jam`
2. **Problem name** (slug): e.g. `security-battle-royale`, `s3-secure-bucket`
3. **Title** (Japanese OK): e.g. "S3 バケットセキュリティ強化"
4. **Difficulty**: `easy` / `medium` / `hard` / `400` (GameDay level)
5. **Category**: `security` / `architecture` / `cost` / `reliability` / `performance` / `operations`
6. **AWS services used**: list of services
7. **Scenario / description**: what the player needs to do
8. **Scoring criteria**: what tasks/conditions earn points
9. **Estimated play time**: e.g. 30分, 240分

## Step 2: Create README.md

```markdown
# {Title}

| 項目 | 内容 |
|------|------|
| 種別 | {type: JAM（構築型）or GameDay（攻撃・防御型）} |
| 難易度 | {difficulty} |
| 想定時間 | {estimated time} |
| AWSサービス | {services} |

## 概要

{scenario description}

## 採点基準

| タスク | 配点 |
|--------|------|
| {task 1} | {points} |
| {task 2} | {points} |

## デプロイ手順

```bash
STACK_NAME={problem-name} ./scripts/deploy.sh
```

## 検証

```bash
aws cloudformation describe-stacks --stack-name {problem-name}
```

```

## Step 3: Create problem.yaml (JAM only)

```yaml
id: {problem-name}
title: {title}
type: jam
category: {category}
difficulty: {difficulty}

metadata:
  author: TenkaCloud Team
  version: 1.0.0
  createdAt: "{YYYY-MM-DD}"
  updatedAt: "{YYYY-MM-DD}"
  tags: [{tag1}, {tag2}]
  license: MIT

description:
  overview: |
    {scenario}

scoring:
  totalPoints: {total}
  criteria:
    - id: task-1
      description: "{task 1 description}"
      points: {points}
      verification:
        type: cloudformation-output | aws-api | manual
        check: "{what to check}"
```

## Step 4: Create cloudformation/{name}.yaml

Write a self-contained CloudFormation template that:

- Provisions the infrastructure the player needs to **start** with (intentionally misconfigured / incomplete for JAM)
- OR provisions the full competitive environment for GameDay
- Uses `Parameters` for customization (e.g. `StackName`, `VpcId`)
- Exports important values in `Outputs` for verification

**JAM template pattern** (broken → player fixes it):

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: "{problem title} — starter environment with issues to fix"

Parameters:
  Environment:
    Type: String
    Default: dev

Resources:
  # ... intentionally misconfigured resources ...

Outputs:
  ResourceArn:
    Description: "Resource ARN for scoring verification"
    Value: !GetAtt Resource.Arn
```

**GameDay template pattern** (full working environment, intentionally vulnerable):

- Same as `security-battle-royale/cloudformation/team-stack.yaml` — provision EC2, RDS, S3, IAM per team

## Step 5: Create scripts/deploy.sh

For JAM problems, use the standard template:

```bash
#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBLEM_DIR="$(dirname "$SCRIPT_DIR")"
PROBLEM_NAME="$(basename "$PROBLEM_DIR")"
STACK_NAME="${STACK_NAME:-$PROBLEM_NAME}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CFN_TEMPLATE=$(ls "$PROBLEM_DIR"/cloudformation/*.yaml | head -1)
echo "Deploying $PROBLEM_NAME → $STACK_NAME ($AWS_REGION)"
aws cloudformation deploy \
  --template-file "$CFN_TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --region "$AWS_REGION"
echo "✓ Done"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs" --output table 2>/dev/null || true
```

For GameDay problems, follow the pattern in `security-battle-royale/scripts/deploy.sh`.

## Step 6: Make deploy.sh executable

Always run:

```bash
chmod +x problems/{type}/{name}/scripts/deploy.sh
```

## Quality Checklist

Before finishing, verify:

- [ ] `cloudformation/*.yaml` is valid YAML (no syntax errors)
- [ ] CFn template has `AWSTemplateFormatVersion` and `Description`
- [ ] All resources are tagged with meaningful tags
- [ ] `Outputs` exports enough info for scoring verification
- [ ] `scripts/deploy.sh` is executable and uses `STACK_NAME` / `AWS_REGION` env vars
- [ ] `README.md` has scoring criteria table
- [ ] Problem path is `problems/{gameday|jam}/{problem-name}/`

## Example invocation

User: "S3 バケットが公開設定になってる問題を作って、プレーヤーが適切なアクセス制限を設定する JAM 問題"

You should create:

- `problems/jam/s3-secure-bucket/README.md`
- `problems/jam/s3-secure-bucket/problem.yaml`
- `problems/jam/s3-secure-bucket/cloudformation/s3-secure-bucket.yaml` (with `BlockPublicAcls: false` etc.)
- `problems/jam/s3-secure-bucket/scripts/deploy.sh`
