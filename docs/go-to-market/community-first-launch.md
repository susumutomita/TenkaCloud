# Community-First Launch Validation

TenkaCloud should validate buyer intent with a small community-first release before broad OSS promotion. The launch goal is not to maximize stars, likes, or Product Hunt ranking. The goal is to discover who immediately understands the value, who has budget authority, and which use case creates a concrete request for a demo, introduction, or internal trial.

This document is the operating checklist for issue #1133.

## Hypothesis

The most likely early adopters are:

1. CCoE and internal platform leaders who need realistic cloud enablement.
2. Training and enablement owners who run hands-on AWS learning programs.
3. AWS partners and SI organizations that package workshops for customers.
4. SRE and security exercise owners who run incident drills or GameDays.
5. Engineering communities that want cloud competitions without heavy setup.

The validation order should favor people who can name a concrete event, team, or buying process over people who only react positively to the project.

## Release Package

Prepare these assets before broad promotion:

| Asset | Purpose | Done when |
| --- | --- | --- |
| 30-60 second GIF | Shows the complete value loop: create event, deploy problem, participant starts solving. | A viewer can understand the product without reading the README. |
| 5 minute setup flow | Removes the "looks too heavy" objection. | A fresh evaluator can reach a local or Lite mode demo in one short sitting. |
| Lite mode demo | Enables evaluation without committing to a full tenant deployment. | The demo can be shared with a training owner or community organizer. |
| One-page architecture visual | Builds confidence for technical buyers. | It explains control plane, tenant plane, and competitor AWS account boundaries on one page. |
| Persona ask | Turns reactions into demand signals. | Every outreach message asks which use case the recipient would use this for. |

The standard ask is:

```text
What would you use this for?

- training
- hiring
- GameDay
- incident drills
- cloud competitions
```

## Outreach Sequence

Use small batches so message wording can improve between rounds.

| Round | Audience | Sample size | Question to answer |
| --- | --- | ---: | --- |
| 1 | Known AWS builders, community organizers, and training operators | 10-15 people | Which use case is understood fastest? |
| 2 | CCoE, platform, SRE, and security enablement leaders | 10-20 people | Who asks for a demo or internal trial? |
| 3 | AWS partners and SI workshop owners | 10-20 people | Is there a service-package or customer-workshop angle? |
| 4 | Public OSS channels | Small public post | Does broader interest match the private signal, or only produce shallow engagement? |

Do not scale the launch until at least one audience produces a concrete next step.

## Signal Log

Record every conversation with these fields:

| Field | Meaning |
| --- | --- |
| Contact type | CCoE, training, partner, SRE/security, community, other. |
| Use case selected | Training, hiring, GameDay, incident drills, cloud competitions, other. |
| Strength | Passive interest, shared with others, demo requested, manager intro, pricing question, internal trial request. |
| Objection | Setup weight, security model, AWS account requirement, cost, unclear use case, missing content. |
| Follow-up | No action, send demo, schedule call, prepare internal pilot, introduce buyer. |

Strong signals are:

- Demo requests.
- Introductions to managers or budget owners.
- "Can we use this internally?"
- "Can you run this for us?"
- Pricing, procurement, or event date questions.

Weak signals are:

- Stars, likes, reposts, and vague encouragement without a next step.
- Feedback from people who cannot name a concrete event or team.
- Interest that only appears when the setup is assumed to be free and fully hosted.

## Message Test

Test three message angles before choosing public positioning.

| Angle | Example | Winning signal |
| --- | --- | --- |
| Cloud enablement | "Run realistic AWS training without building a custom workshop platform." | Training owners ask for content format, duration, and participant limits. |
| GameDay operations | "Launch and score cloud challenges with tenant isolation and participant AWS accounts." | SRE/security teams ask about incident-drill workflows. |
| Partner workshop kit | "Package reusable cloud competition environments for customer workshops." | Partners ask whether they can reuse or white-label events. |

Retire any angle that produces compliments but no demo request, buyer intro, or event-specific follow-up.

## Decision Gate

Proceed to broader OSS promotion only when at least two of these are true:

- Three or more demo requests from the same audience class.
- One buyer or budget owner asks for an internal pilot.
- One AWS partner or SI asks how to package it for customers.
- One community organizer commits to running a small event.
- Objections are specific enough to prioritize product work.

If none of these happen, do not optimize the landing page or public launch. Revise the audience, message, or Lite demo first.

## PR Checklist

For launch-readiness PRs related to this plan, include:

- The asset or experiment being added.
- The intended audience.
- The demand signal it is meant to test.
- The success and stop criteria.
- The expected physical impact, including whether the change is docs-only, app-only, or infrastructure-affecting.
