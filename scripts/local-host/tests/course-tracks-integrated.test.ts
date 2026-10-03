import { test } from "bun:test";
import { verifyCourseTracks } from "./course-tracks-browser-e2e";

test("local HTTP/SQLite and safe catalog project assigned course checkpoints, gates and restart", async () => {
  await verifyCourseTracks();
});
