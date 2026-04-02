# Quickstart

TenkaCloud をローカルで試すための最短手順です。詳細な内部向け手順は `docs/QUICKSTART.md` を正本とします。

## Prerequisites

- Docker Desktop
- Bun
- AWS CLI
- Terraform

## Start

```bash
make install
make start
```

## URLs

- Control Plane: `http://localhost:13000/control`
- Application Plane: `http://localhost:13001/`
- Tenant API: `http://localhost:13004/api/tenants`
- Problem API: `http://localhost:3100/api`
- GameDay API: `http://localhost:3020/api/gameday`

## Authentication

- Production-like: Auth0
- Local development: `AUTH_SKIP=1`

## Related

- [Architecture](/guide/architecture)
- [GitHub](https://github.com/susumutomita/TenkaCloud)
