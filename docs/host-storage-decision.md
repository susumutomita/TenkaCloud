# Host storage and AWS trust boundary

## Decision

A host deployment is one process with one SQLite database on a local or attached
persistent disk. Its dedicated data directory also contains the host key and the
competitor ExternalId. The current implementation stores the ExternalId in
`competitor-external-id`, not in SQLite or SSM Parameter Store. The same file is
reused after restart; an invalid existing value causes startup to fail instead
of silently generating a replacement.

The directory is private to the process owner. On POSIX systems the host requires
mode `0700` for an existing directory and uses mode `0600` for private files. It
rejects symlinked directories and linked key files. These filesystem checks do
not encrypt the database or protect it from the machine administrator.

SQLite holds organizer accounts and sessions, competitor registrations, event
state and operational records. SAML correlation and replay protection are
mandatory authentication state. Optional audit collection is a separate feature
flag, defaults OFF, and writes only to the host database. Turning audit OFF does
not turn off operational or authentication records.

## Why

The host must start and retain competition state without an AWS-hosted control
plane. Requiring SSM or a remote database for host state would reintroduce an
external service dependency and its continuing operation costs. Reusing a local
private key file also matches the existing host key lifecycle.

This changes the trust boundary from cloud-managed storage access to possession
of the host disk and process account. The operator must provide disk and backup
access control. If at-rest encryption is required, configure it on the disk or
volume. This implementation does not claim application-level encryption or a
KMS-protected secret store.

## AWS authorization

The host obtains operator credentials through the AWS SDK credential chain.
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

Changing from Lite/SaaS, DynamoDB or Turso to the host does not migrate any data or
remove existing cloud resources. Those environments require a separate migration
or retirement decision. The new host schema migrations apply only to supported
host SQLite versions. Running two host processes against one data directory or
using a network filesystem is outside this storage contract.
