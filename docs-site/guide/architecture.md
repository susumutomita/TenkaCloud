# アーキテクチャ

TenkaCloud は、共有管理面を担う Control Plane と、競技体験を担う Application Plane を分離しています。

## 構成

```text
TenkaCloud
├── apps/control-plane
├── apps/application-plane
├── backend/services/control-plane/*
├── backend/services/application-plane/*
├── backend/services/shared/*
└── packages/*
```

## Control Plane

- テナント管理
- 設定管理
- 登録、プロビジョニング、ユーザー管理の導線

## Application Plane

- GameDay
- Battle
- 問題管理
- 採点
- リーダーボード

## 認証

- 本番相当: Auth0
- ローカル確認: `AUTH_SKIP=1`

## ローカル URL

- Control Plane: `http://localhost:13000/control`
- Application Plane: `http://localhost:13001/`
- Tenant API: `http://localhost:13004/api/tenants`
- Problem API: `http://localhost:3100/api`
- GameDay API: `http://localhost:3020/api/gameday`

内部向けの詳細は `docs/architecture/architecture.md` を参照してください。
