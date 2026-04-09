# JAM 問題ライブラリ

TenkaCloud JAM 形式の問題セット。各問題は CloudFormation 1 枚で独立デプロイ可能。

## 構成

```
jam/
├── core/         # 基本問題セット（20問）
└── generated/    # 生成問題バリアント（84問）
```

## 問題の標準構造

```
{problem-name}/
├── README.md              # 問題説明・要件・採点基準
├── problem.yaml           # TenkaCloud プラットフォーム用メタデータ
├── cloudformation/
│   └── *.yaml             # CloudFormation テンプレート（デプロイ本体）
└── scripts/
    └── deploy.sh          # 独立デプロイスクリプト
```

## 新問題の追加

```bash
/create-problem
```

Claude Code の `create-problem` スキルを使うと標準構造の雛形が自動生成される。

## デプロイ方法

```bash
# 個別問題のデプロイ
cd core/alb-auto-scaling
STACK_NAME=my-alb-stack AWS_REGION=us-east-1 ./scripts/deploy.sh

# または直接 aws cloudformation
aws cloudformation deploy \
  --template-file cloudformation/*.yaml \
  --stack-name my-stack \
  --capabilities CAPABILITY_NAMED_IAM
```
