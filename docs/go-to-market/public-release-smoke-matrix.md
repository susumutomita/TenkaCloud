# Public-release smoke matrix

| Item | Value |
|---|---|
| Tracking issue | [#1868](https://github.com/susumutomita/TenkaCloud/issues/1868) |
| Owner | Release facilitator or the person signing the public demo gate |
| When to run | Before an external community demo, public release announcement, or paid-event dry run |
| Output | A completed pass/fail record with evidence links and follow-up issues for every failure |

This matrix is the repeatable browser, responsive, accessibility, and performance smoke artifact for TenkaCloud's public surfaces. It does not replace unit tests or `make before-commit`; it records the human-observable checks that matter before the project is shown outside a controlled maintainer environment.

Do not silently fix failures inside the smoke run. If a product defect is found, create a separate issue, link it in the "Defect issue" column, and decide whether it blocks the release gate.

## Run record template

Create one run record per release gate. The record can live in a PR comment, GitHub issue comment, or event run sheet. Do not commit customer screenshots, login keys, tenant secrets, or AWS account identifiers.

| Field | Value |
|---|---|
| Date / operator | |
| Git commit | |
| Environment | Local / Lite / SaaS / deployed preview |
| URLs tested | Landing, docs, admin-console, application-admin-console, participant-portal |
| Browsers tested | Chrome, Firefox, Safari |
| Viewports tested | Mobile, tablet, desktop |
| Long-name fixture used | Event / team / problem names copied from the fixture below |
| Result | Pass / conditional pass / fail |
| Follow-up issues | |

## Required browsers and viewports

| Browser / device | Minimum version policy | Mobile 390×844 | Tablet 768×1024 | Desktop 1440×900 | Result | Evidence | Defect issue |
|---|---|---:|---:|---:|---|---|---|
| Chrome stable | Current stable on the operator machine | Required | Required | Required | | | |
| Firefox stable | Current stable on the operator machine | Optional if no mobile device; desktop required | Optional | Required | | | |
| Safari | Current Safari on macOS and iOS when available | Required on iOS for public launch; otherwise record N/A | Optional | Required on macOS for paid-event sign-off | | | |

If Safari is unavailable in the operator environment, record the gap explicitly. A public release can accept that risk; a paid event with customer devices that include Safari should not.

## Long-name fixture

Use these values in at least one event, team, and problem flow. If the deployed environment cannot safely create test data, use a mocked/local environment and record that boundary.

| Field | Fixture value |
|---|---|
| Event name | `Public Release Smoke - Long Event Name With 80 Characters 2026 External Demo` |
| Team name | `Team Long Name - Tokyo Cloud Migration Workshop Participants Alpha` |
| Problem name | `Microservice Migration Battle - Cross-Team Registered URL Health Check` |
| Operator display name | `Release Facilitator With Long Display Name` |

## Surface matrix

| Surface | Flow | Required checks | Result | Evidence | Defect issue |
|---|---|---|---|---|---|
| Landing / docs site | Home page, global navigation, gallery, docs links, community/commercial links | Loads with no console errors; keyboard tab order reaches primary links; current page has a meaningful title; mobile width does not crop content; long link text wraps; external links open expected targets | | | |
| Landing / docs site | Search-by-reading smoke | A first-time visitor can reach quickstart, problem gallery, runbooks, security posture, and public-quality review within 3 clicks from the landing page or docs index | | | |
| Admin Console | Unauthenticated login surface | Cognito Hosted UI redirect or configured login entry is visible; keyboard focus lands on the first actionable control; auth errors do not expose stack traces or raw HTML | | | |
| Admin Console | Tenant list and tenant detail | Long tenant/event names wrap without overlapping controls; table sorting/filtering remains keyboard reachable; icon-only controls have accessible names | | | |
| Admin Console | Operations / jobs / audit views | Empty, loading, error, and populated states are distinguishable without relying only on color; modal or drill-down focus returns to the opener | | | |
| Application Admin Console | Login and event list | Login flow is reachable; expired/unauthorized state is understandable; mobile/tablet layout keeps primary event actions visible | | | |
| Application Admin Console | Event create and event detail | Event creation works or a documented mock/API fixture is used; long event/team names remain readable; primary actions are keyboard reachable | | | |
| Application Admin Console | Problem catalog and deploy detail | Problem detail opens; deploy request path is visible; deployment status and errors include text labels; copy buttons and external links have accessible names | | | |
| Application Admin Console | Competitor account and secret modal | Modal traps focus; Escape/close works; focus returns to the opener; secret fields are not copied into screenshots or public evidence | | | |
| Application Admin Console | Notifications | Create/send flow or mock equivalent is checked; success/error feedback is visible in text; repeated sends do not duplicate UI rows unexpectedly | | | |
| Participant Portal | Team login | Login key entry is reachable by keyboard; invalid key shows a text error; local storage expiry path is understandable; mobile layout does not hide the submit action | | | |
| Participant Portal | Setup / AWS console handoff | Setup instructions fit mobile and tablet widths; external console links are labeled; unavailable federation paths fail with a user-readable message | | | |
| Participant Portal | Problem list and problem detail | Long problem names wrap; markdown content is readable; hints/phases/disruptions only show public information; submission controls are keyboard reachable | | | |
| Participant Portal | Scoreboard | Team names and scores remain readable at mobile/tablet/desktop widths; current team is identifiable without relying only on color | | | |
| Participant Portal | Notifications | Info/warning notifications render within one polling interval in a real environment or via mock fixture locally; screen-reader-visible text exists for severity and time | | | |

## Accessibility smoke

Run these checks on each application surface at desktop width, then repeat the keyboard-only path on mobile width for the participant portal and landing/docs.

| Check | How to verify | Result | Evidence | Defect issue |
|---|---|---|---|---|
| Keyboard-only primary flow | Use Tab / Shift+Tab / Enter / Space. Mouse must not be required for login, navigation, event detail, deploy/problem detail, participant problem detail, scoreboard, or notifications. | | | |
| Modal focus behavior | Open each modal in the matrix, confirm focus moves into the modal, cannot escape behind it with Tab, closes with the documented close control, and returns to the opener. | | | |
| Icon-only labels | Inspect buttons/links without visible text. Each has visible tooltip text, `aria-label`, or component-provided accessible name. | | | |
| Error and status text | Loading, success, warning, error, and disabled states are expressed with text, not color alone. | | | |
| Page title and heading | Browser title and primary heading describe the current surface. This can be a document title for static docs and an app heading for SPA screens. | | | |
| Screen reader quick pass | Use the browser accessibility tree or a screen reader spot check on at least landing/docs, event detail, deploy/problem detail, participant problem detail, and scoreboard. | | | |

## Performance and bundle observations

Record observations; do not add a hard budget here unless the repo already enforces one. A "fail" means the operator believes the release would visibly degrade a public demo.

| Surface | Observation | Result | Evidence | Defect issue |
|---|---|---|---|---|
| Landing / docs | Initial load has no broken images, severe layout shift, or console errors; large media is intentional and visible. | | | |
| Admin Console | Initial app shell renders without a blank screen after config load; built asset sizes are recorded from the build output or browser network panel. | | | |
| Application Admin Console | Event/detail/deploy screens do not lock the browser while loading mock or real API data; built asset sizes are recorded. | | | |
| Participant Portal | Team login, problem detail, scoreboard, and notifications remain responsive on mobile width; built asset sizes are recorded. | | | |
| API-backed flows | Slow or failed API calls show a bounded loading/error state and do not create duplicate mutations when retried from the UI. | | | |

## Release decision

| Condition | Decision |
|---|---|
| Every required row passes | The public-release smoke gate can be marked pass for this commit. |
| A row fails but has a non-blocking issue | Mark conditional pass, link the issue, and record why the defect does not block this release. |
| Login, deploy/problem detail, participant problem detail, scoreboard, modal focus, or secret handling fails | Mark fail. Do not proceed to public release or paid-event dry run until the blocking issue is fixed. |
| Evidence cannot be shared publicly because it contains customer data | Store it in the private event run sheet and link only the sanitized summary in public issues. |

## Links

- Public-quality review: [public-quality-review.md](./public-quality-review.md).
- Launch readiness: [launch-readiness.html](./launch-readiness.html).
- Event runbook gate: [pre-event checklist](../runbooks/pre-event-checklist.md).
- Browser/runtime checks still required before merge: `make harness` and `make before-commit`.
