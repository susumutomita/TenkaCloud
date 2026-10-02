# Claim a prepared team from an invitation

The current host registration feature allocates an existing ready team. It does
not create a team, AWS account or exercise during registration. It is off by
default; an Admin manages its feature flag and the event's Teams settings.

## Organizer preparation

Start with `make local`, prepare the event and deploy every selected team's
required environments. Enable registration, select undistributed ready teams,
set a deadline and save the invitation. Distribute that link securely; reissuing
it invalidates the previous invitation while preserving existing claims.

## Participant flow

Open the invitation and claim a team. The browser saves a receipt so a retry or
lost response can return the same team. Once ready, use the assigned team key in
the ordinary participant portal. Do not share keys or receipts.

## Revocation and persistence

Closing registration or disabling its flag prevents new claims, but does not
reset existing allocations or revoke ordinary team access. Ending/expiring the
event blocks receipt access. Rotating a team's key invalidates its old receipt;
it never reveals the replacement key. `make down` retains registration state.

The [host registration contract](../host-participant-registration.md) describes
readiness checks, atomic allocation and receipt behavior. These use retained
records; they are not fresh cloud health checks. Real deployment and complete
Docker/terminal playability need separate evidence.
