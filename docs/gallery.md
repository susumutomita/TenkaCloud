# Competition Gallery

This gallery helps new authors answer one question quickly: "What should I
create next?"

Each entry is a reusable competition concept. Some are already implemented as
problem directories; others are deliberately scoped as starter ideas.

## Available Now

| Name | Difficulty | Category | Scoring model | Best for |
| --- | --- | --- | --- | --- |
| [Hello World](../problems/challenges/hello-world/) | 1 | Challenge | `flag` | First deploy, scoring sanity check, author onboarding |
| [Hello World Battle](../problems/battles/hello-world-battle/) | 1 | Battle | uptime | First uptime battle, AWS Systems Manager practice |
| [Security Battle Royale](../problems/battles/security-battle-royale/) | 4 | Battle | `uptime-multi` | Web security hardening and attacker/defender exercises |
| [Microservice Migration Battle](../problems/battles/microservice-migration-battle/) | 4 | Battle | `phased-polling` | Platform modernization and migration planning |
| [StackStack](../problems/battles/stackstack/) | 4 | Battle | `phased-polling` | Platform-team operations for AI-generated internal apps |

## Curated Examples

### Hello World

- **Concept**: read a value from SSM Parameter Store and submit it as a flag.
- **Difficulty**: 1 / 5.
- **Category**: Challenge.
- **Learning goals**: AWS Console basics, SSM Parameter Store, deploy-to-score
  flow.
- **Scoring model**: `flag`.
- **Visual cue**: one input form in the Participant Portal and one CloudFormation
  output.

### Hello World Battle

- **Concept**: keep nginx and a Python API alive while health checks award
  points every minute.
- **Difficulty**: 1 / 5.
- **Category**: Battle.
- **Learning goals**: uptime scoring, EC2 process recovery, AWS Systems Manager.
- **Scoring model**: uptime checks against frontend and API endpoints.
- **Visual cue**: two endpoint cards, a health timeline, and score increments.

### Security Battle Royale

- **Concept**: attack and defend a deliberately vulnerable web application.
- **Difficulty**: 4 / 5.
- **Category**: Battle.
- **Learning goals**: SQL injection, remote code execution, SSRF, IMDS exposure,
  and safe remediation.
- **Scoring model**: `uptime-multi` across frontend and API slots.
- **Visual cue**: frontend/API endpoint cards with hardening notes and health
  status.

### Microservice Migration Battle

- **Concept**: split a three-service monolith into Lambda, ECS Fargate, and App
  Runner under scoring pressure.
- **Difficulty**: 4 / 5.
- **Category**: Battle.
- **Learning goals**: strangler migration, managed-runtime tradeoffs, endpoint
  override registration.
- **Scoring model**: `phased-polling` with platform self-reporting.
- **Visual cue**: users/orders/catalog slots moving from EC2 to managed
  platforms.

### StackStack

- **Concept**: act as a platform team shipping fragile AI-generated apps to
  production.
- **Difficulty**: 4 / 5.
- **Category**: Battle.
- **Learning goals**: auth, network controls, rate limiting, auditability, and
  user-facing availability.
- **Scoring model**: `phased-polling` across five control axes, with disruption
  events.
- **Visual cue**: five-axis score panel and incident timeline.

## Build Next

These examples are intentionally small enough for external contributors to turn
into first PRs.

### IAM Disaster Recovery

- **Concept**: a team receives a broken IAM boundary and must restore least
  privilege without losing application access.
- **Difficulty**: 2 / 5.
- **Category**: Challenge.
- **Learning goals**: IAM policy reading, CloudTrail triage, least-privilege
  repair.
- **Scoring model**: `flag`, with the flag emitted after the expected IAM repair.
- **Starter scope**: create `metadata.json`, a minimal `template.yaml`, and a
  README explaining the repair path.

### AI Agent Stampede

- **Concept**: many internal AI agents call the same service, and teams must
  add rate limits and audit trails before the service degrades.
- **Difficulty**: 3 / 5.
- **Category**: Battle.
- **Learning goals**: throttling, concurrency limits, audit logging, and graceful
  degradation.
- **Scoring model**: `phased-polling` or `uptime-multi`.
- **Starter scope**: prototype a single API endpoint and document the expected
  portal slots.

## Choosing A Scoring Model

| If the player must... | Start with |
| --- | --- |
| Find one value and submit it | `flag` |
| Keep one public service healthy | `uptime-flat` |
| Keep multiple slots healthy together | `uptime-multi` |
| Progress through time-based phases | `phased-polling` |
| Detect or count adversarial activity | `attack-detection` |

Problem authoring guide: [docs/problems/AUTHORING.html](./problems/AUTHORING.html)
