/** Fresh-clone local hosting uses Bun + SQLite; Docker is needed for Docker exercises. */
export const LOCAL_ONBOARDING_COMMANDS = [
  "git clone https://github.com/susumutomita/TenkaCloud.git",
  "cd TenkaCloud",
  "make install",
  "make local",
] as const;
