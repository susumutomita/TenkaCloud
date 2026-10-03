# Running costs

Choose hosting based on the exercises and resources you need. This page describes
the current checkout; it does not promise a zero bill or a measured event budget.

| Hosting | Cost and capacity boundary |
| --- | --- |
| Local | One Bun process and persistent SQLite. Docker exercises use your machine's CPU, memory and disk; native Cryptography Battle needs no Docker or AWS |
| AWS | Lambda, API Gateway, Cognito, CloudFront, S3, the selected database, logs and exercise resources. Source-bundle and problem deployment builds also use CodeBuild |

Cloud hosting supports Turso or DynamoDB. Turso mode creates no DynamoDB tables;
its external database has its own plan and usage limits. Local protocol measurements
do not establish hosted Turso pricing or performance.
See [cloud implementation status](../infrastructure/README.md).

## Before an event

- Review the AWS region, selected exercises and expected duration. Problem resources
  can cost more than the platform itself.
- Check current provider pricing and your account's allowances. A free allowance
  is account-specific and may already be consumed by another application.
- Rehearse your expected concurrency, including environment starts and scoring
  bursts. A catalog count or a synthetic allocation test is not a capacity estimate.
- For local hosting, review [resource limits and measurement](local-play-requirements.md).
  Defaults cap active environments and configured container memory; they do not
  measure or reserve the computer's physical memory.

## After an event

`make down` stops local processes and owned Docker runtimes, preserving database,
keys, writable layers and volumes. Use explicit event Teardown to remove problem
environments when they are no longer needed.

`make destroy` removes owned cloud hosting and its default-owned data. DynamoDB
tables are deleted unless explicitly deployed with retention; ordinary destroy
leaves external Turso rows. `make destroy-all` explicitly purges stack-owned retained
data and resets the selected Turso control-data rows. Recorded problem deployments
are separate: finish event Teardown before removing the platform. `--drain-events`
is unavailable in the restored backend. Check the result and inventory.
Retained storage and any remaining AWS resources may still incur charges. Shared
CDK bootstrap resources, the source archive bucket and competitor bootstrap roles
are separate; do not remove shared resources while other applications
use them. The [cloud operations guide](../infrastructure/README.md) describes
ownership, retained data and failed-operation recovery.

Each pinned cloud deployment writes a fresh source ZIP key and retains its exact
S3 version. Later uploads do not make that key noncurrent, so noncurrent-version
expiration does not remove it. These archives accumulate storage charges until
separately reviewed cleanup of the owned source bucket, after all referencing
events finish; event teardown is not automatic source garbage collection.

Deleting a launcher alone does not remove the application it deployed. Switching
a storage backend also does not migrate or delete data automatically.
