# DynamoDB capacity for cloud events

The current cloud data stack uses `PAY_PER_REQUEST` billing. There is no current
`make` command to raise or lower provisioned read/write units before an event.
Do not apply a fixed 1/1 capacity recipe to these tables.

## Before an event

Rehearse the selected problems with the expected number of teams. Record response
times, DynamoDB throttling and failed operations while teams start environments,
submit answers and refresh scores together. Synchronized Cryptography Battle
bursts still exceed the five-second refresh interval; on-demand billing alone
does not establish sufficient application performance.

Review the account's DynamoDB quotas and any configured table throughput limits.
Capacity and cost decisions must use the actual deployed table configuration,
region and measured workload. Local hosting uses SQLite and has a separate
[Docker capacity boundary](../local-play-requirements.md).

## After an event

Check that scoring and problem work have stopped and inspect retained resources.
`make destroy` coordinates cloud teardown while preserving event data. Storage can
continue to incur charges. See [cloud operations](../../infrastructure/README.md)
and [cost boundaries](../running-costs.md).
