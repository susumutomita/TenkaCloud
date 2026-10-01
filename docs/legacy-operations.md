# Existing SaaS, Lite and local practice installations

The host-only source tree cannot deploy, update, migrate or tear down the old
platform. It does not read DynamoDB, Turso or local-play databases. Installing it
does not change existing AWS resources or participant keys.

Use the exact release that created your environment and its own documentation.
The existing v1.11.0 release is a legacy launcher release, not a host release.
Its immutable platform commit is `949a40a9ed9199331d928ad5cf9397dbb4ba3f81`.

```sh
git clone --no-checkout https://github.com/susumutomita/TenkaCloud.git TenkaCloud-legacy
cd TenkaCloud-legacy
git checkout --detach 949a40a9ed9199331d928ad5cf9397dbb4ba3f81
git submodule update --init --recursive
```

Read that checkout's README, `mise.toml`, release manifest and operating guide.
Use that release's pinned tools and dependencies. If your environment predates
v1.11.0, select its actual recorded tag/commit instead of upgrading implicitly.
Keep its data, secrets, deployment configuration and backups separate from the
host's data directory. Do not point both implementations at the same storage.

The old checkout retains the CDK/Lambda deploy and teardown commands, Lite
launcher, `make local`, tcloud and machine API specification. Any update,
resource deletion or data conversion needs a separately reviewed plan and the
owner's authorization. This retirement performs none of those operations.
