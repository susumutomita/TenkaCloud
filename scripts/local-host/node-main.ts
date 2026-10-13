import { runLocalHost } from "./application";

// Run from a checked-out repository with the existing host UI already built.
// Runtime source/catalog paths are explicit; bundle placement never determines repository identity.
await runLocalHost([...process.argv.slice(2), "--no-build"], { repositoryRoot: process.cwd() });
