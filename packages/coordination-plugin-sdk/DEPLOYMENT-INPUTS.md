# Deployment inputs (SDK 0.2)

`CoordinationContext.deploymentInputs` optionally maps each roster team ID to
trusted deployment outputs. Both the participant dispatcher and scoring tick
resolve the same tenant/event/problem roster. The platform passes output names
matching `Coordination[A-Z]`; unrelated outputs and other problems are excluded.
The client operation body cannot supply or override this context.

Names beginning with `CoordinationPrivate` are server-only. The participant
problem lookup removes these outputs, including stack-prefixed output names.
Deployment log lines naming these outputs are redacted. Do not log their values
separately. A problem plugin must also exclude them from `projectForTeam`, hints,
errors and public artifacts. CloudFormation outputs themselves are not a secret
vault: keep participant IAM scoped to the intended resource, not stack inspection.

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
