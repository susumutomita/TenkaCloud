import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { initializeLabCgroup } from "./network-lab-cgroup.mjs";

test("direct execution without opt-in refuses before filesystem access", () => {
  const result = spawnSync(process.execPath, [new URL("./network-lab-cgroup.mjs", import.meta.url).pathname], {
    env: { TENKACLOUD_LAB_CGROUP_INIT: "0" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Explicit disposable-lab cgroup initialization approval is required/);
});

function fixture(overrides = {}) {
  const files = {
    "/proc/1/cgroup": "0::/\n",
    "/proc/7/cgroup": "0::/\n",
    "/sys/fs/cgroup/cgroup.type": "domain\n",
    "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids io\n",
    "/sys/fs/cgroup/cgroup.procs": "1\n7\n",
    "/sys/fs/cgroup/cgroup.subtree_control": "",
    ...overrides,
  };
  const writes = [];
  const io = {
    read(path) {
      assert.ok(Object.hasOwn(files, path), `Unexpected read: ${path}`);
      return files[path];
    },
    mkdir(path) {
      assert.equal(path, "/sys/fs/cgroup/init");
      writes.push(["mkdir", path]);
    },
    write(path, value) {
      writes.push([path, value]);
      if (path.endsWith("/init/cgroup.procs"))
        files["/sys/fs/cgroup/cgroup.procs"] = files["/sys/fs/cgroup/cgroup.procs"]
          .split("\n").filter((pid) => pid !== value).join("\n");
      else if (path.endsWith("/cgroup.subtree_control"))
        files[path] = "cpu memory pids";
      else assert.fail(`Unexpected write: ${path}`);
    },
  };
  return { io, writes, files };
}

test("moves only validated lab PIDs, empties the root, then delegates only approved controllers", () => {
  const { io, writes } = fixture();
  initializeLabCgroup(io);
  assert.deepEqual(writes, [
    ["mkdir", "/sys/fs/cgroup/init"],
    ["/sys/fs/cgroup/init/cgroup.procs", "1"],
    ["/sys/fs/cgroup/init/cgroup.procs", "7"],
    ["/sys/fs/cgroup/cgroup.subtree_control", "+cpu +memory +pids"],
  ]);
});

for (const [name, overrides] of [
  ["non-root namespace", { "/proc/1/cgroup": "0::/other" }],
  ["invalid domain", { "/sys/fs/cgroup/cgroup.type": "domain invalid" }],
  ["threaded domain", { "/sys/fs/cgroup/cgroup.type": "domain threaded" }],
  ["missing controller", { "/sys/fs/cgroup/cgroup.controllers": "cpu pids" }],
  ["invisible PID", { "/sys/fs/cgroup/cgroup.procs": "0\n1" }],
  ["peer PID", { "/proc/7/cgroup": "0::/peer" }],
]) test(`rejects ${name} before mutation`, () => {
  const { io, writes } = fixture(overrides);
  assert.throws(() => initializeLabCgroup(io));
  assert.deepEqual(writes, []);
});

test("a concurrently populated root fails before enabling controllers", () => {
  const { io, writes } = fixture();
  io.write = (path, value) => writes.push([path, value]);
  assert.throws(() => initializeLabCgroup(io), /still contains processes/);
  assert.ok(writes.every(([path]) => !path.endsWith("subtree_control")));
});

test("refuses to adopt an existing init subtree", () => {
  const { io, writes } = fixture();
  io.mkdir = () => { throw new Error("EEXIST"); };
  assert.throws(() => initializeLabCgroup(io), /EEXIST/);
  assert.deepEqual(writes, []);
});

test("requires controller write confirmation", () => {
  const { io } = fixture();
  const write = io.write;
  io.write = (path, value) => {
    if (!path.endsWith("subtree_control")) write(path, value);
  };
  assert.throws(() => initializeLabCgroup(io), /not confirmed/);
});

test("workflow keeps delegation opt-in, in a private namespace, with capped preflight", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/local-host-rehearsal.yml", import.meta.url), "utf8");
  assert.match(workflow, /network_lab_cgroup_init:[\s\S]*?default: false/);
  assert.match(workflow, /github.event_name == 'workflow_dispatch' && inputs.network_lab_cgroup_init/);
  assert.match(workflow, /--network none --cgroupns private/);
  assert.match(workflow, /--memory 128m --cpus 0.5 --pids-limit 128/);
  assert.ok(workflow.indexOf('if [ "$initialized" != 1 ]') < workflow.indexOf('if docker exec "$lab" docker info'));
});
