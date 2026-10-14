// Only the explicitly opted-in, private-cgroup-namespace disposable lab calls this.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = "/sys/fs/cgroup";

export function initializeLabCgroup(io) {
  const read = (name) => io.read(`${root}/${name}`).trim();
  if (io.read("/proc/1/cgroup").trim() !== "0::/")
    throw new Error("Lab PID 1 must be at its private cgroup namespace root");
  if (read("cgroup.type") !== "domain")
    throw new Error("Lab root must already be a valid domain; ancestor/type repair is forbidden");
  const available = read("cgroup.controllers").split(/\s+/);
  for (const controller of ["cpu", "memory", "pids"])
    if (!available.includes(controller)) throw new Error(`Missing delegated ${controller}`);
  const pids = read("cgroup.procs").split(/\s+/);
  if (!pids.includes("1") || pids.some((pid) => !/^[1-9]\d*$/.test(pid)))
    throw new Error("Expected only visible lab processes at the namespace root");
  // Validate every target before any write. Never enumerate or modify ancestors/peers.
  for (const pid of pids)
    if (io.read(`/proc/${pid}/cgroup`).trim() !== "0::/")
      throw new Error(`PID ${pid} is outside the lab root`);
  io.mkdir(`${root}/init`); // exclusive creation: do not adopt a pre-existing subtree
  for (const pid of pids) io.write(`${root}/init/cgroup.procs`, pid);
  if (read("cgroup.procs") !== "") throw new Error("Lab root still contains processes");
  io.write(`${root}/cgroup.subtree_control`, "+cpu +memory +pids");
  const enabled = read("cgroup.subtree_control").split(/\s+/);
  if (!["cpu", "memory", "pids"].every((controller) => enabled.includes(controller)))
    throw new Error("Lab controller delegation was not confirmed");
}

if (import.meta.main) {
  if (process.env.TENKACLOUD_LAB_CGROUP_INIT !== "1" || process.getuid?.() !== 0)
    throw new Error("Explicit disposable-lab cgroup initialization approval is required");
  initializeLabCgroup({
    read: (path) => readFileSync(path, "utf8"),
    mkdir: (path) => mkdirSync(path),
    write: (path, value) => writeFileSync(path, value),
  });
  console.log("LAB_CGROUP_CPU_MEMORY_PIDS_DELEGATED");
}
