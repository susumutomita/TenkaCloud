# Local storage and cloud trust boundaries

## Local hosting

Local hosting uses one Bun process with one SQLite database on a local or attached
persistent disk. Its dedicated data directory contains the host key. `make local`
does not configure AWS clients and refuses the former `--aws-region` option.

An earlier AWS-enabled host revision may also have saved a competitor ExternalId
in `competitor-external-id`. Retain that file with its database for reviewed
recovery; it is not a new cloud secret store. An invalid existing value must fail
instead of silently generating a replacement.

The directory is private to the process owner. On POSIX systems the host requires
mode `0700` for an existing directory and uses mode `0600` for private files. It
rejects symlinked directories and linked key files. These filesystem checks do
not encrypt the database or protect it from the machine administrator.

SQLite holds organizer accounts and sessions, competitor registrations, event
state and operational records. SAML correlation and replay protection are
mandatory authentication state. Optional audit collection is a separate feature
flag, defaults OFF, and writes only to the host database. Turning audit OFF does
not turn off operational or authentication records.

## Local persistence boundary

Local hosting must start and retain competition state without an external
control plane or database. This local requirement does not remove the separate
Lambda/DynamoDB cloud-hosting path.

This changes the trust boundary from cloud-managed storage access to possession
of the host disk and process account. The operator must provide disk and backup
access control. If at-rest encryption is required, configure it on the disk or
volume. This implementation does not claim application-level encryption or a
KMS-protected secret store.

## Cloud storage and authorization

The cloud candidate uses Lambda and DynamoDB, reusing the former single-installation
cloud path without SaaS/SBT provisioning. Its existing three tables retain events,
teams, deployment work, scoring and retry receipts. No SQLite or Turso driver is
used by this cloud path. Initial setup, complete exercise execution and coordinated
platform teardown remain under verification; see [cloud status](../infrastructure/README.md).

The opt-in flag runner assumes only explicitly configured competitor role ARNs
and reads ExternalId values from their configured SSM parameter ARNs. These values
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
requires its original host key. A retained competitor account or CloudFormation
job also requires the original ExternalId; startup refuses a missing key before
contacting AWS or changing the database.

The database does not record whether AWS was enabled before the first account or
job was saved. Without those records, a missing ExternalId is indistinguishable
from enabling AWS for the first time on a local-only host. Complete-directory
backups remain required; the startup checks cannot detect every partial restore.

Changing deployment models does not migrate existing Lite/SaaS, DynamoDB, Turso
or practice-mode data, and does not remove their resources. Existing installations
need their exact legacy release and a separately reviewed migration or retirement
plan. The new host schema migrations apply only to supported
host SQLite versions. Running two host processes against one data directory or
using a network filesystem is outside this storage contract.
