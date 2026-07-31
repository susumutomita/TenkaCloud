process.on("SIGTERM", () => {});
process.on("SIGUSR1", () => process.exit(0));
process.stdout.write("TENKACLOUD_IGNORE_SIGTERM_READY\n");
setInterval(() => {}, 1_000);
