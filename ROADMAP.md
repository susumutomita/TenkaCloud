# Roadmap

TenkaCloud is moving toward a simple path for running real cloud competitions:
start with Lite mode, grow into richer scenarios, then share problems as a
community catalog.

This roadmap is the near-term, contributor-facing view. For the longer-term
product direction — local drills → courses / enterprise training → team
competitions → global community — see [`docs/vision.md`](./docs/vision.md).

## Now

These areas are active and ready for contributors.

| Area | Direction | Good first contribution shape |
| --- | --- | --- |
| Lite mode | Make one-organizer events easy to deploy, inspect, and tear down | Improve command docs, error messages, and local status output |
| Problem DX | Make problem authoring feel like adding a small plugin | Add examples, metadata validation messages, and starter templates |
| Community feedback | Help first-time readers understand the product quickly | Improve README, gallery entries, screenshots, and onboarding docs |

## Next

| Area | Direction | Expected outcome |
| --- | --- | --- |
| Problem marketplace | Turn curated examples into a browsable catalog | Authors can discover, copy, and adapt proven competition patterns |
| Battle formats | Grow real-time, head-to-head competition beyond today's single-team deploy/score loop | More Battle formats for organizers to run |
| Offline emulator | Let contributors test flows without full AWS deployment | LocalStack and frontend mock paths for faster iteration |
| Operations polish | Make event day diagnosis easier | Clearer deploy logs, sandbox lifecycle state, and health checks |

## Future

| Area | Direction |
| --- | --- |
| Cloud competition ecosystem | Shared problem packs, reusable judging models, and event templates |
| Multi-cloud authority transfer | Broaden Trust Bridge's AWS/Azure/GCP adapters (already live as the Always-On mode command seam) to more providers and operation scopes |
| Author analytics | Feedback loops that show where players get stuck and what to improve |

## Good First Issue Candidates

These are repo-local starter tasks. They can become GitHub issues when a
maintainer wants to reserve one for a contributor.

### Example Problem: IAM Disaster Recovery

- **Why it helps**: IAM repair is a common GameDay scenario and fits a small
  Challenge.
- **Files**: `problems/challenges/iam-disaster-recovery/metadata.json`,
  `template.yaml`, and optional README (in the [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) catalog repo).
- **Validation**: the catalog repo's authoring tooling.

### UI Polish: Empty State For No Deployments

- **Why it helps**: first-time operators need a clear next action before any
  deploy exists.
- **Files**: Participant Portal or Application Admin Console page components.
- **Validation**: focused Vitest coverage plus the relevant app test command.

## Contribution Flow

1. Pick a starter task or an existing issue.
2. Keep the PR small: one behavior, one doc set, or one problem scaffold.
3. Add or update tests when code behavior changes.
4. Run `make harness` and `make before-commit` before asking for review.

Contributor guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
