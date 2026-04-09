# Security Battle Royale

| 項目 | 内容 |
|------|------|
| 種別 | GameDay（攻撃・防御型） |
| 難易度 | 400 |
| 想定時間 | 240分 |
| AWSサービス | EC2, RDS (MySQL), S3, IAM, SSM, Secrets Manager |
| リージョン | us-east-1 |

## 概要

Unicorn.Rentals というレンタルサービス企業でセキュリティインシデントが発生。
各チームに AWS アカウントが割り当てられ、**自チームのインフラを守りながら他チームの脆弱性を攻撃**し、最高スコアを目指す。

## スコアリング

| イベント | ポイント |
|---------|---------|
| Website + API 両方UP | **+100pt / 60秒** |
| どちらかDOWN（通常） | **-100pt / 60秒** |
| どちらかDOWN（高ペナルティ） | **-1,000pt / 60秒** |
| EC2 インスタンス1台に最適化 | **+100pt / 60秒** |
| 攻撃成功（攻撃者） | +1,000pt |
| 攻撃成功（被害者） | -1,000pt |
| 攻撃ブロック（脆弱性修正済） | +1,000pt |
| 攻撃購入コスト | -3,000pt |

## チーム環境構成

```
 Auditor (60秒ごと)
    │
    ├── GET http://<S3-Website>/         → Website UP check
    └── GET http://<EC2-IP>/api/v1/apistatus → API UP check

 各チームの AWS アカウント:
    S3 Bucket (unicornrentals-website-{team})
        └── index.html  ← Unicorn.Rentals フロントページ

    EC2 (API Flask App)
        └── api.py  ← 意図的脆弱性を含む Flask API (port 80)

    RDS MySQL (cavsdb)
        └── username テーブル（unicorn データ）
```

## 意図的脆弱性一覧

| エンドポイント | 脆弱性 |
|--------------|--------|
| `/api/v1/unicorns?id=` | **SQL インジェクション**（f-string クエリ） |
| `/api/v1/unicorns/login` | **SQL インジェクション** + **平文パスワード GET 送信** |
| `/api/v1/unicorn` (POST) | **推測容易なデフォルトパスワード**（`name@123`） |
| `/api/v1/proxy?url=` | **SSRF**（任意 URL にリクエスト） |
| `/backdoor?cmd=` | **RCE**（subprocess shell 実行） |
| `get_db_connection()` | **ハードコードパスワード**（adminadmin） |
| Flask 設定 | **DEBUG=True**（スタックトレース公開） |

## フォルダ構成

```
security-battle-royale/
├── README.md                     ← このファイル
├── cloudformation/
│   └── team-stack.yaml           ← デプロイ本体（1スタック = 1チーム）
├── api/
│   └── api.py                    ← Flask API（CAVS_SSM_PARAM_NAME 対応）
├── frontend/
│   └── index.html                ← S3 静的サイト
└── scripts/
    └── deploy.sh                 ← デプロイスクリプト
```

## デプロイ手順

### 前提

- AWS CLI 設定済み（EventAccount の管理者権限）
- 対象リージョンに VPC + パブリックサブネット x2 が存在する

### 1. ソースコードバケット作成（初回のみ）

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3 mb s3://tenkacloud-gameday-applicationsourcecode-${ACCOUNT_ID} --region us-east-1
```

### 2. デプロイ

```bash
cd problems/gameday/security-battle-royale

export AWS_REGION=us-east-1
export BUCKET=tenkacloud-gameday-applicationsourcecode-<ACCOUNT_ID>
export VPC_ID=vpc-xxxxxxxxxxxxxxxxx
export SUBNET1=subnet-xxxxxxxxxxxxxxxxx
export SUBNET2=subnet-yyyyyyyyyyyyyyyyy
export TEAMS="team01 team02 team03"

chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

### 3. コードのみ更新（スタック再作成不要の場合）

```bash
SKIP_CFN=1 TEAMS="team01" ./scripts/deploy.sh
```

## Auditor チェック相当の動作確認

```bash
# API が返す想定値を確認
curl http://<EC2-IP>/api/v1/apistatus  # → "CAVS APIs are UP"
curl http://<EC2-IP>/api/v1/region     # → "us-east-1"

# S3 ウェブサイト
curl http://unicornrentals-website-team01.s3-website-us-east-1.amazonaws.com/
```

## CloudFormation スタック管理

```bash
# スタック一覧
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName, `UnicornRentals`)].StackName'

# スタック削除（チームの環境を破棄）
aws cloudformation delete-stack --stack-name UnicornRentals-team01
```

## CAVS_SSM_PARAM_NAME について

`api.py` は環境変数 `CAVS_SSM_PARAM_NAME` で SSM パラメータ名を上書きできる。
これにより **複数チームを同一 AWS アカウントにデプロイ可能**。

- デフォルト（未設定）: `CAVS_DB_ENDPOINT`（元の動作と互換）
- GameDay デプロイ時: `/gameday/{TeamName}/CAVS_DB_ENDPOINT`（CFn が自動設定）
