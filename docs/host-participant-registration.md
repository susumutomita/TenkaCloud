# Host participant registration

The host allocates an existing team to each registration receipt. It does not
create teams, AWS accounts or environments during registration. The registration
feature is off by default; its settings and allocations live in the host's SQLite
file. Existing cloud registrations are not imported.

## Organizer settings

The event's **Teams** tab includes **Let participants claim their environment**.
An Admin can enable registration on the host, select undistributed teams, set a
registration deadline and issue a link. Operator and Viewer accounts can read the
settings, but cannot change the pool or the feature flag.

Every selected team must have a valid login key and a completed environment for
each current problem. The host checks the current problem definition and any
pending environment operation. For CloudFormation, the retained environment must
also match the team's current AWS account and role. Docker and Battle teams do
not require an AWS account. These checks use the host's deployment records; they
do not perform a new network health check.

The invitation is returned only when settings are saved and appears in the URL
fragment. Refreshing the settings does not reveal it again. Reissuing the link
invalidates the previous invitation and preserves existing allocations. Claimed
teams cannot be removed from the pool.

## Participant receipts

The participant page removes the invitation fragment from the address bar and
keeps it in `sessionStorage`. Before claiming, it saves a random receipt in local
storage, scoped to the host origin, event and tenant. A retry with that receipt
returns the same team, including after a lost response or a host restart.

Closing registration, reaching its deadline or disabling the host registration
flag prevents new allocations. Existing receipts can still retrieve their team
while the event is active. An environment that is preparing or no longer ready
is reported without a login key. Ending or expiring the event stops receipt
access. Rotating the team's login key makes the old receipt return
`receipt_revoked`; it never reveals the replacement key.

Disabling registration preserves its configuration and allocations. Previously
issued participant keys keep their ordinary participant access; the feature flag
does not revoke them. Turning registration on again does not allocate another
team to an existing receipt.

## HTTP and storage contract

Admin settings use `GET` and `PUT /events/:eventId/registration`. The host flag uses
`GET` and `PUT /feature-flags` with `{ "key": "registration", "enabled": true }`.
The flag API remains available to an Admin while the flag is off. Registration
settings remain readable while off; their PUT returns `feature_disabled`.

The participant listener accepts `POST` at
`/portal/registration/local-host/:eventId/info`, `/claim` and `/status`.
Info and claim authenticate with the invitation in the Bearer header. Claim
accepts only `{ "receipt": "..." }`. Status authenticates with the receipt in its
Bearer header. Public registration request bodies are limited to 1 KiB.

Invitation verification, current feature/event/deadline/readiness checks,
allocation and the audit hook run in one synchronous SQLite transaction. Unique
keys on `(event_id, receipt_hash)` and `(event_id, team_id)` prevent duplicate
allocations. New registration tables store hashes of invitations and receipts,
and bind each claim to the login-key hash at issue time. The existing team record
retains its login key for the ordinary participant login flow.

`service.registration.onMutation` receives an action, event ID, optional team ID
and action time. It must write synchronously within the current transaction. The
payload contains no invitation, receipt or login key. An audit write failure rolls
back the allocation; a successful receipt retry emits no duplicate claim action.
