# TenkaCloud Vision

This is the first version of TenkaCloud's product vision — the canonical
explanation of where the project is heading, for contributors, users,
companies, and external communities. Shorter summaries derived from it are
expected to show up later in the README, the landing page, blog posts, and
introduction material for outside communities — but only once those summaries
actually exist; nothing in this document should be read as announcing them in
advance.

> TenkaCloud aims to be both the practice field and the arena: learners build
> operational judgment through safe, repeatable local drills, then prove and
> deepen that judgment in team-based competitions — and, over time, in a
> global community that builds and runs its own problems.

```text
local drills -> practical courses / enterprise training -> team competitions / GameDay -> global community
```

Throughout this document, **Live today** marks something you can go run right
now, and **Direction** marks something we are building toward but have not
shipped. Keeping that distinction honest is the point of writing this down.

## Why we need a training ground before competition

Security and cloud/application operations are hard to learn from lectures or
slides alone. The skill that actually matters — deciding what to stop,
update, delete, or restrict when something looks wrong — only forms by
looking at real screens, logs, settings, infrastructure, and symptoms, and
making a call.

Most learners do not have a safe place to build that judgment before they are
dropped into a competition, or worse, a real incident. Existing CTF and
GameDay formats are built for people who already have the reflexes; walking
in without them is intimidating, and a single high-pressure event does not
build a reflex — repetition does.

TenkaCloud's answer is to put a training ground in front of the arena: local,
self-paced drills first, then progressively higher-stakes, higher-collaboration
formats.

## Local drills: practice operational judgment safely

Local drills are not a stripped-down demo of the competition. They are a
different exercise with a different goal: build the reflex of "look, then
decide" with no clock, no team, and no AWS account required.

**Live today** — `make local` runs an entirely local, Docker-based drill loop
(see [`local-play.md`](./local-play.md)): a problem container serves the
challenge surface and its own `/verify`, and the platform contributes only the
scoring API, portal, leaderboard, and hints. Today's local-play catalog is
built around approachable Web application operations subjects, for example:

- `wp-exposed-backup` / `wp-harden-leaks` — inspect a live WordPress +
  database stack, find files and settings a previous operator left exposed
  (public backups, config copies, debug logs, browsable directories), then
  close them until an external scanner reports the site clean.
- `sqli-demo`, `api-idor-demo`, `rls-tenant-isolation`, `wix-exposure-audit` —
  inspect logs and settings, find a risky access path or exposed resource,
  and decide what to fix.

The pattern behind all of them — inspect logs, check settings, find risky
users or permissions, detect exposed files, identify outdated components,
decide what to stop, update, delete, or restrict — is deliberately not
AWS-specific. WordPress is the first approachable subject because almost
everyone can picture "a website with a leaky backup." **Direction** — the
same pattern is the template for expanding local drills into cloud, CI/CD,
GitHub, IAM, SaaS, Kubernetes, and other operational domains; that expansion
has not been built yet.

## From drills to courses to competitions

| Stage | What it is | Status |
| --- | --- | --- |
| 1. Local drills | Self-paced, individual practice (`make local`) | **Live today** |
| 2. Courses | Structured learning paths with trust/signaling value | **Direction** — not designed or built yet |
| 3. Enterprise training | Private/custom exercises for a company's own needs | **Direction** — today this is an intake conversation, not a packaged product (see below) |
| 4. Team competitions / GameDay | Battle (real-time, head-to-head) and Challenge (self-paced, evergreen) — TenkaCloud's names for what AWS competition culture called GameDay/JAM — run on real, isolated AWS accounts | **Live today**, in both single-tenant Lite mode and multi-tenant SaaS mode |
| 5. Global community | OSS problem ecosystem and international competitions | **Partially live** — the OSS catalog is real; cross-community events are a direction |

Local drills are the entry point precisely because they ask for nothing: no
team, no registration, no AWS bill. Courses and enterprise training are the
connective tissue still to be designed between "I practiced alone" and "I
competed with a team." Team competitions are where judgment gets tested under
pressure and alongside other people. Global community is the long horizon: an
open catalog that other organizers, students, and companies build on.

## Open source problem ecosystem

The platform (this repo) and the problem catalog
([TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge))
are deliberately separate repositories — the three-asset problem model
(`metadata.json` + `template.yaml`/`local/` + optional `portal/`). This is
already how the project works today, not an aspiration:

- Anyone can fork the catalog and add or change problems without touching the
  platform — see [Add your own problems](../README.md#add-your-own-problems).
- The platform stays a generic dispatcher: scoring, portal rendering, hints,
  and disruption scheduling are all driven from a problem's metadata, never
  hardcoded per problem.
- Open problems are free for students, hobbyists, and communities to run.
- Private/closed problem content is also supported today: a spoiler-bearing
  problem can ship its payload through a separate S3 + presigned-URL delivery
  path with per-problem visibility control, so a company's proprietary
  scenario does not need to become public to run on TenkaCloud.

**Direction** — external contributors building whole problem sets around
their own technologies (a Kubernetes-focused pack, a CI/CD-focused pack, and
so on) at a scale beyond the handful of subject areas the catalog covers
today.

## Enterprise and custom training

None of this is a shipped product yet. What exists today is an open door:
the README's [Enterprise / internal training](../README.md#enterprise--internal-training)
section and [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
are where a company can start a conversation about hands-on
security/operations training.

**Direction** — where we want this to grow:

- company-specific training materials, built on the same problem model as
  public problems
- custom incident-response drills modeled on a company's own stack or past
  incidents
- instructor-led workshops
- certification or course-completion signaling (tying back to the "Courses"
  stage above)
- collaboration with education/security organizations
- a possible introduction to communities such as IPA, SECCON, DEF CON
  villages, OWASP, and BSides

We are not claiming any of these relationships exist yet — writing them down
here is what makes them a direction instead of an accident.

## Long-term direction: app + infra operations competition

TenkaCloud started from AWS-native, GameDay-style team competitions: deploy a
problem into an isolated AWS account, score it, run it as Battle (real-time)
or Challenge (self-paced). That part of the platform is built and running
today, in both Lite mode (single organizer, single tenant) and SaaS mode
(multi-tenant).

Local drills expand that into practical **application** operations and
security practice — today, Web app operations via WordPress and a handful of
app-security patterns — without requiring an AWS account at all.

**Direction** — bring both halves under one platform: a single application +
infrastructure operations competition and learning platform, where the same
portal, scoring model, and hint system carry a learner from "find the leaked
backup on a WordPress site" to "hold IAM, CI/CD, and Kubernetes together
under a live team competition." We are not there yet; this document exists so
contributors and problem authors can build toward that direction
deliberately instead of by accident.

## What we want next

- Expand local drills beyond Web app operations into cloud, CI/CD, GitHub,
  IAM, SaaS, and Kubernetes subjects, keeping the same "inspect, then decide"
  pattern.
- Design what a "course" actually is on top of the existing problem model,
  instead of leaving it as a label.
- Turn enterprise conversations (via the contact form / Discussions) into a
  first real pilot.
- Keep growing the open problem catalog — see
  [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)
  and [ROADMAP.md](../ROADMAP.md) for concrete, contributor-sized next steps.

This first version is kept intentionally short so it can be shared outside
the repo as-is. If the direction changes, update this document — it is the
source, not a summary.
