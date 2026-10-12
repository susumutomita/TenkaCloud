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
Before teardown, back up required event data and save the physical-resource inventory:

```sh
make -s destroy ENV=development CLOUD_ARGS="--plan" > teardown-plan.txt
```

`make destroy` confirms the selected account, region and environment and applies
the deployed removal policies. By default it deletes stack-owned DynamoDB tables
and their rows; only tables deployed with `CDK_PARAM_RETAIN_DATA_TABLES=true` are
retained. Editing local configuration alone does not change a deployed policy.
External Turso rows remain. Retained resources can continue to incur charges.
Exercise teardown is separate, and competitor bootstrap and shared CDKToolkit
resources remain outside platform destruction. `make destroy-all` explicitly
purges verified stack-owned retained data and the selected Turso control-data rows;
it is not a backup operation. See [cloud operations](../../infrastructure/README.md)
and [cost boundaries](../running-costs.md).
