import { openSqliteLocalPlayStateStore } from "../../../scripts/local-play/sqlite-state-store";

const path = process.argv[2];
if (!path) throw new Error("database path is required");

const store = await openSqliteLocalPlayStateStore(path);
await store.save({
  version: 1,
  teamName: "SQLite team",
  runtimes: {},
  simulatedRuntimes: {},
  scoreEvents: [],
});
const beforeClear = await store.load();
await store.clear();
const afterClear = await store.load();
console.log(JSON.stringify({ beforeClear, afterClear }));
await store.close();
