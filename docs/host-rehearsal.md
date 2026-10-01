# Optional host event rehearsal

A live rehearsal checks the final host image with a disposable competitor account
and an external identity provider. It is optional for development completion.
Local tests and CI use explicit AWS adapters and a local signed SAML provider;
they do not prove a real AWS or external IdP connection.

## Before starting

Get the owner's approval for the AWS accounts, region, temporary resources,
disruption commands and cleanup. Record the Git commit and image digest being
rehearsed. Use a new host data volume and a new event. Do not reuse an ongoing
competition or migrate a Lite/SaaS database.

The host needs a local, attached persistent disk for its SQLite database and key
files. Run one host process against that database. Put the two public origins
behind a TLS proxy and pass their original Host headers. Use the deployment
platform's AWS role or another approved credential source. Do not put credentials
in the image, command history, screenshots or rehearsal report.

Build the exact reviewed checkout after initializing its pinned problem catalog:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile --ignore-scripts
bun run build:host
docker build -f docker/host/Dockerfile -t tenkacloud-host:rehearsal .
```

Use the command and proxy requirements in [local hosting](local-hosting.md), adding
`--aws-region` for the approved commercial AWS region. Keep the admin and
participant ports reachable only by the proxy. Mount a dedicated `/data` volume.
The container does not run Docker exercises through the host's Docker socket;
use the direct host process when rehearsing Docker problems.

## Exercise the event

1. Read the new host's bootstrap key through the approved administrative path.
   Create its first local Admin, then an Operator and Viewer. Confirm that the
   host key cannot sign in again and that the Viewer cannot change an event.
2. Register the disposable competitor accounts. Use the displayed operator
   account, ExternalId and exact role name with `competitor-bootstrap.yaml`.
   Verify each account and select it for a separate event team. Keep the template's
   AdministratorAccess exception confined to competitor bootstrap.
3. Create and deploy an event containing the reviewed Hello World cloud problem.
   Confirm separate stacks, correct team assignment, participant instructions,
   flag submission, hints and the resulting scores. Team A must not retrieve
   Team B's deployment or credentials.
4. Open the participant AWS console and reveal short-lived CLI credentials.
   Confirm the viewer role's allowed resources. End the event or rotate a team
   key while an access request is pending and confirm that no new credentials
   are returned. Already issued AWS sessions remain valid until AWS expires or
   revokes them.
5. In a separate Hello World Battle event, register both endpoint URLs. Confirm
   that initial preparation precedes scoring and that each scoring minute is
   counted once. Run the reviewed disruption only against the approved team.
   Compare command status, endpoint health and score history. Revert-command
   completion alone is not evidence that the service recovered.
6. Enable a progression gate and check both teams independently. A locked problem
   must withhold its metadata, gameplay operations and new AWS credentials.
   Complete prerequisites and verify that the completion bonus is awarded once,
   including after host restart. Previously issued AWS credentials are not revoked
   by the gate.
7. Enable participant registration and claim a prepared team. Retry with the same
   receipt, including after a deliberately lost response. Stop new registrations
   and confirm that the existing receipt can still retrieve its original team.
   Rotate that team's key and confirm that the old receipt cannot retrieve the
   replacement key.
8. Configure the external SAML provider and explicitly link an existing organizer.
   Sign in through the provider. Disable SAML while a login is pending and confirm
   rejection. Re-enable it and confirm that old sessions stay invalid. Keep a local
   password Admin available throughout the rehearsal.
9. With audit collection initially OFF, confirm that no audit history is created.
   Enable collection, change an event, then inspect and export the record. Stop
   collection and confirm that retained history remains readable. Do not include
   passwords, keys, SAML responses or temporary AWS credentials in the report.
10. Restart only this rehearsal host with its existing volume. Confirm that users,
    accepted operations, team assignments, scores and registration receipts survive.
    Finish the event and remove its environments. Verify actual CloudFormation
    deletion and any retained-resource state before closing the rehearsal.

## Record results

Use one row per observed result:

| Commit / image digest | Area | Expected result | Actual result | Evidence without credentials |
| --- | --- | --- | --- | --- |
| To be recorded | AWS deployment and cleanup | Team stacks created and removed | Not run | None |
| To be recorded | Participant AWS access | Correct viewer role and expiry | Not run | None |
| To be recorded | Disruption and scoring | Command, health and score agree | Not run | None |
| To be recorded | External SAML | Linked user and revocation work | Not run | None |

Record failures and resources that still need cleanup. A failed rehearsal is not
a successful deployment. An unrun rehearsal is not a claim of live compatibility
and, by itself, does not keep a completed development Issue open.
