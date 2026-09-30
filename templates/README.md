# Competitor account bootstrap

`competitor-bootstrap.yaml` is the unchanged competitor-account initialization
template moved from the retired infrastructure workspace. Use the operator
identity and ExternalId supplied by the host's competitor account setup flow.
The `AdministratorAccess` exception is limited to this initialization role;
do not extend it to participant or organizer roles.

Problem CloudFormation templates remain in `problems/`. This directory does not
contain a template for deploying the host platform. See
[host storage and trust](../docs/host-storage-decision.md).
