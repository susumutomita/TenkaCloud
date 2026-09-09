# Deployment inputs (SDK 0.2)

`CoordinationContext.deploymentInputs` optionally maps each roster team ID to
trusted deployment outputs. Both the participant dispatcher and scoring tick
resolve the same tenant/event/problem roster. The platform passes output names
matching `Coordination[A-Z]`; unrelated outputs and other problems are excluded.
The client operation body cannot supply or override this context.

This contract uses event-scoped regular deployment rows. Composite parents are
not indexed for event roster or participant login queries; their targets are
indexed only by parent. The current coordination host does not admit these
composite deployments, so this field does not transport composite target outputs.

Names beginning with `CoordinationPrivate` are server-only. Hosted problem views,
endpoint responses and simulated participant views use `isPrivateCoordinationOutputKey` to remove them,
including stack-prefixed output names. The deployment
script filters structured outputs before logging; downstream log redaction also
removes lines naming private outputs. Do not log private values separately.
A problem plugin must also exclude them from `projectForTeam`, hints,
errors and public artifacts. CloudFormation outputs themselves are not a secret
vault: keep participant IAM scoped to the intended resource, not stack inspection.

When an operation or scheduled tick initializes durable state, the index discovers
deployments and strongly consistent META reads provide the values. Only the
newest deployment per team is read, with at most eight reads in flight; duplicate
index entries and superseded deployment history do not add reads. Read-only
previews of an absent run use only the newest index row per team, without per-deployment reads;
that snapshot can lag and is never persisted. The first write resolves fresh
inputs independently. A shared, 30-second initialization lease admits one writer
per tenant/event/problem/run before these META reads. Operations, scheduled ticks
and reset initialization share it across dispatcher instances; concurrent operations
return the existing retryable conflict response, while a tick retries on its next pass.
The owner releases the lease on completion or error. Expiry permits takeover after
a crashed invocation, and the first state write atomically checks the owner token
so an old owner cannot overwrite its successor. Teardown revokes the lease, and
the existing retention sweep also removes expired leases. This uses one temporary
row in the existing DynamoDB table, or the idempotently created
`coordination_initialization_lease` SQL table; no AWS resource or permission is added.

Operations outside the active event window skip roster reads
and are rejected using the server clock. Existing-run requests check the scoped state and skip
roster discovery and per-deployment reads. The dispatcher reuses that request's
scope-checked state snapshot for the first read/tick, and reloads after a tick or
write conflict; ordinary projection polling therefore reads state only once.
If state disappears after that check,
initialization waits for a request that loads the complete roster. A missing or
mismatched row defers initialization. This does not make index discovery strongly
consistent: wait for all deployments to be discoverable.

Present malformed output JSON or invalid output entries defer initialization;
valid empty maps/arrays and absent outputs remain compatible. Corrupt outputs
must not silently become a durable context with missing/default inputs.

`initialState` consumes the inputs once. Existing saved matches do not change
when a stack is redeployed. Finish all team deployments before creating a match;
a plugin with required inputs must reject incomplete or inconsistent settings.
Missing optional inputs preserve compatibility with existing plugins and stacks.

This contract adds no service, runtime permission, API route, or problem-specific
branch. Plugins continue to submit ordinary operations and return state and
scores through the existing coordination transaction and durable score delivery.
Deploy the platform reader and private-output filtering together with any
problem that declares private coordination outputs; an older platform does not
implement the private-output contract.
