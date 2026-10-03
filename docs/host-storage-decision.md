# Local storage and cloud trust boundaries

## Local hosting

Local hosting uses one Bun process with one SQLite database on a local or attached
persistent disk. SQLite stores the organizer-key hash and rotation version; the
private `host-key` file is a separate internal signing key. `make local`
does not configure AWS clients and refuses the former `--aws-region` option.

An earlier AWS-enabled host revision may also have saved a competitor ExternalId
in `competitor-external-id`. Retain that file with its database for reviewed
recovery; it is not a new cloud secret store. An invalid existing value must fail
instead of silently generating a replacement.

The directory is private to the process owner. On POSIX systems the host requires
mode `0700` for an existing directory and uses mode `0600` for private files. It
rejects symlinked directories and linked key files. These filesystem checks do
not encrypt the database or protect it from the machine administrator.

SQLite holds organizer token hashes, competitor registrations, participant keys,
event state and operational records. Historical organizer/SAML records are retained
but cannot authenticate in current local key mode. New organizer sign-in collects
no username, email or password. Optional audit collection is a separate feature
flag, defaults OFF, and writes only to the host database. Turning audit OFF does
not turn off operational or authentication records.

## Local persistence boundary

Local hosting must start and retain competition state without an external
control plane or database. This local requirement does not remove the separate
Lambda cloud-hosting path with Turso or DynamoDB.

This changes the trust boundary from cloud-managed storage access to possession
of the host disk and process account. The operator must provide disk and backup
access control. If at-rest encryption is required, configure it on the disk or
volume. This implementation does not claim application-level encryption or a
KMS-protected secret store.

## Cloud storage and authorization

The cloud candidate uses Lambda with Turso or DynamoDB, reusing the former
single-installation cloud path without SaaS/SBT provisioning. Both adapters store
the original event, team, deployment, scoring, endpoint and coordination records
with their repository transaction contracts. Both providers admit 99 event teams;
SQL coordination retains the original 4 MiB state policy. Turso uses the HTTP client and an exact SSM token parameter; no DynamoDB
tables are created in that mode. Local hosting continues to use SQLite.
Provider changes do not migrate data and are rejected for an existing installation.
Published cloud-v1 stack resource IDs are incompatible with the restored Lite
layout; deployment refuses to overwrite them. Turso preflight rejects nonempty or
unrecognized `cloud_*` schemas. Known version-1 retired tables left empty after
explicit purge may coexist without being dropped or migrated. Original unpinned
Lite upgrades also require confirmation that no active competitions remain before
bootstrap/source upload/deployment; keep active events on the installed version. A
legacy catalog key does not replace that check or migrate historical data.
See [cloud status and database setup](../infrastructure/README.md#database-selection).

The restored deployment workflows use registered competitor roles and mandatory
ExternalId values from the existing SSM path. These values
are not browser configuration. Local data-directory keys are not uploaded or
adopted automatically. This candidate does not guarantee zero AWS charges.

### Retained earlier AWS-host contracts

The following describes retained implementation and recovery constraints for an
earlier AWS-enabled host, not an available `make local` option. That host obtains operator credentials through the AWS SDK credential chain.
Those credentials are not supplied through host command-line flags. Each
competitor account must trust the operator identity and require the persisted
ExternalId when the host assumes its deployment role. The ExternalId is an
additional trust-policy condition; it does not replace AWS identity authorization.

The competitor-account bootstrap modal reveals connection information only to an Admin.
Operator and Viewer permissions do not allow changing competitor connections.
Participant AWS access first rechecks the competitor deploy role, then uses the
operator credentials to assume the deployment's retained viewer role with the job
ID as its ExternalId. The viewer role trusts the operator account. Participant
responses never contain the deployment role's credentials.

The `AdministratorAccess` exception in `competitor-bootstrap.yaml` remains
limited to initializing competitor accounts. Do not extend that policy to
organizers, participant viewer roles or other runtime roles.

## Backups, recovery and non-migration

Back up the dedicated data directory as one unit using a procedure consistent
with SQLite. A stopped host has no active writer; a live backup needs a SQLite
backup operation that includes committed WAL state. Copying only a database file
while it is being written is not the documented backup procedure.

Restore the database and key files together with their ownership and permissions.
Losing or replacing the ExternalId breaks competitor trust until the account
owner deliberately updates that trust policy. An existing nonempty host database
requires its original internal signing key. This file is not the organizer login
key. A lost organizer login key can be rotated with `make local-reset`, preserving
event state and participant access. A retained competitor account or CloudFormation
job also requires the original ExternalId; startup refuses a missing key before
contacting AWS or changing the database.

The database does not record whether AWS was enabled before the first account or
job was saved. Without those records, a missing ExternalId is indistinguishable
from enabling AWS for the first time on a local-only host. Complete-directory
backups remain required; the startup checks cannot detect every partial restore.

Changing deployment models does not migrate existing Lite/SaaS, DynamoDB, Turso
or practice-mode data, and does not remove their resources. Data conversion and resource retirement require an explicit, reviewed
plan. The new host schema migrations apply only to supported
host SQLite versions. Running two host processes against one data directory or
using a network filesystem is outside this storage contract.
