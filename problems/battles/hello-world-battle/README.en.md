# Hello World Battle (Sample)

> 日本語版: [README.md](./README.md)

The **minimal sample** for Battle uptime scoring. Deploys nginx (frontend) and Python `http.server` (api) on a single EC2 instance; a 1-minute health probe awards +100 points per cycle while both endpoints return 200.

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| Category       | Battle (real-time PvP)                 |
| Difficulty     | 1 / 5 (beginner)                       |
| Estimated time | 30 min                                 |
| status         | `ready`                                |
| Scoring        | `uptime` (`pointsPerSuccess`: 100)     |

## What you do

As the new SRE on duty, defend the two endpoints (`FrontendUrl` / `ApiUrl`) deployed at start, and restore service via SSM Session Manager whenever attackers knock something down. A probe runs every minute; +100 pt accrues only on cycles where both endpoints return 200.

- **Attackers** tamper with the shared EC2 / Security Group to bring frontend or API down (e.g. `systemctl stop nginx`).
- **Defenders** connect via SSM Session Manager (no SSH) and restart the service.

All operations stay inside one EC2, so there is no cross-tenant impact.

## What gets deployed

```
┌─────── EC2 t3.micro (Amazon Linux 2023, public IP) ───────┐
│  nginx          :80   → /  (FrontendUrl)                  │
│  python3 http.server :8080 → /healthz (ApiUrl)            │
└────────────────────────────────────────────────────────────┘
       ▲
       │ Health Check Lambda probes every 1 minute
       │ Both 200 → +100 pt / cycle
```

- Dedicated VPC (`10.99.0.0/16`) + public subnet + IGW
- InstanceRole for SSM Session Manager (`AmazonSSMManagedInstanceCore`)
- `ParticipantViewerRole` (read-only role competitors AssumeRole into for AWS Console)

## Scoring

| State                                                | Per cycle (1 min) |
| ---------------------------------------------------- | ----------------- |
| `FrontendUrl /` and `ApiUrl /healthz` both return 200 | +100 pt           |
| Either is non-200 / times out                        | 0 pt              |

See the `scoring` field in [`metadata.json`](./metadata.json) for the full spec.

## Cost

- EC2 t3.micro: within AWS Free Tier (750 hr/month for 12 months)
- VPC / IGW / SG: free
- One ~30-minute session is zero-cost while inside the Free Tier.

## Learning goals

- Confirm that TenkaCloud's Battle uptime scoring engine works against real endpoints.
- Experience a minimal EC2 + nginx + Python web stack receiving health-check probes.
- Practice connecting via SSM Session Manager without SSH to start / stop services.

## Related files

- [`metadata.json`](./metadata.json) — problem metadata (source of truth for UI / scoring engine)
- [`template.yaml`](./template.yaml) — one-page CFn template deployed into the competitor account
