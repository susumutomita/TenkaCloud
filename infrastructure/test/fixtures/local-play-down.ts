import { join } from "node:path";
import { openSqliteLocalPlayStateStore } from "../../../scripts/local-play/sqlite-state-store";
import { runLocalPlayCommand } from "../../../scripts/tenkacloud-local";

const directory = process.argv[2];
if (!directory) throw new Error("local directory is required");

const databasePath = join(directory, "local-play.sqlite");
const store = await openSqliteLocalPlayStateStore(databasePath);
await store.save({
  version: 1,
  teamName: "Persisted team",
  runtimes: {},
  simulatedRuntimes: {},
  scoreEvents: [],
});
await store.close();

process.env.TENKACLOUD_LOCAL_DIR = directory;
await runLocalPlayCommand(["down"]);

const reopened = await openSqliteLocalPlayStateStore(databasePath);
console.log(JSON.stringify(await reopened.load()));
await reopened.close();
