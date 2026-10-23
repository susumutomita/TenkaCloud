# Offline platform contract inputs

These frozen test inputs replace the external catalog download in platform CI.
They are not a product catalog, runtime fallback, upstream mirror or publication
source. Normal `make local` and `make deploy` still acquire the operator's sources.

Metadata/runtime shapes were captured from TenkaCloudChallenge v1.11.0
(`0c5f5ad97f73c6e6d3695d6fd832cd2c832e6aa5`, Apache-2.0). Long narrative fields are
synthetic; browser plugin slots are empty React components. The native engine's
import closure is retained to preserve the existing real adapter/HTTP/SQLite
regressions. Its files match v1.12.0
(`68b9fbe0d49f5f1d01e04cf8b52f284fd3153ee1`), the first engine that follows the
match length the platform reports. Images, guides, writeups, tests and unused browser implementation
are omitted. The historical `ac26-crypto-battle` metadata is an override; its
identical engine inputs are reused from `crypto-battle`.

Files ending in `.fixture` are test payloads. The explicit CI preparation command
materializes them under `.tenkacloud/ci-catalog-inputs`, then uses the ordinary
local-source acquisition, validation and snapshot APIs. It cannot replace an
existing non-fixture selection. It neither reads the product's catalog lock nor
fetches Git repositories. There is no synchronization workflow.
